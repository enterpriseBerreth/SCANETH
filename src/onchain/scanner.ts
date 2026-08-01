/**
 * Opportunity scanner.
 *
 * Two-phase by design, because RPC calls are the scarce resource:
 *
 *   Phase 1 (screen)  — effectively free. V2 pools are priced from cached
 *                       reserves; V3 pools get one small batched probe quote.
 *                       Anything whose fee-adjusted spread cannot cover the
 *                       flash premium is discarded here.
 *   Phase 2 (confirm) — only for survivors. V2-only cycles are sized by exact
 *                       local ternary search at zero RPC cost; cycles touching
 *                       V3 are sized with a batched on-chain quote ladder.
 *
 * Screening prices are net of swap fees, so a high-fee pool cannot masquerade
 * as an opportunity.
 */

import { createLogger, errMeta } from '../logger';
import type { ArboConfig } from '../config';
import { AAVE_FLASH_FEE_BPS, BALANCER_FLASH_FEE_BPS, tokenBySymbol } from '../chains';
import { FlashProvider, type ArbOpportunity, type RouteLeg, type TokenInfo } from '../types';
import type { ChainContext } from './provider';
import type { Pool, PoolSet, V2Pool, V3Pool } from './dex';
import { poolsForPair } from './dex';
import { quoteV3Batch, type V3QuoteRequest } from './dex/univ3';
import { PriceOracle } from './prices';
import {
  bestFromLadder,
  gasCostUsd,
  getAmountOutV2,
  isLocallyPriceable,
  optimalSize,
  sizeLadder,
  toBigInt,
  valueUsd,
} from './profit';

const log = createLogger('scanner');

/** Number of ladder rungs used when a cycle contains a V3 leg. */
const LADDER_STEPS = 9;

/** Extra margin over the flash premium required to bother confirming. */
const SCREEN_MARGIN_BPS = 2;

/** Never borrow more than this fraction of a V2 pool's input reserve. */
const MAX_RESERVE_FRACTION_BPS = 3_000; // 30%

/**
 * How far a venue's quoted rate may deviate from the oracle-implied rate before
 * it is treated as broken data rather than opportunity.
 *
 * Uninitialised and abandoned V3 pools exist at every fee tier and quote
 * absurd rates — a live Base DAI/USDC pool screened at ~1e8 DAI per USDC, an
 * apparent 99-billion-percent edge. Real cross-venue edges are basis points, so
 * a 3x band is enormously generous while still discarding every phantom. Without
 * it the scanner spends its entire quote budget confirming garbage.
 */
const MAX_RATE_DEVIATION = 3;

export interface ScanContext {
  ctx: ChainContext;
  pools: PoolSet;
  oracle: PriceOracle;
  config: ArboConfig;
  gasPriceWei: bigint;
}

/**
 * Per-pass instrumentation.
 *
 * Without this a quiet scan and a broken scan look identical: both report zero
 * opportunities. The profit gate discards any cycle whose gross profit is <= 0,
 * which in an efficient market is nearly all of them, so "no near misses" tells
 * you nothing about whether the pipeline actually ran.
 *
 * `bestEdgeBps` is the number that matters: the best fee-adjusted spot edge seen
 * this pass, measured in bps relative to break-even. A steady -3 bps means the
 * code works and the market is tight. `null` means nothing was ever priced,
 * which is a bug in the scanner or the pool set, not market conditions.
 */
export interface ScanDiagnostics {
  pairsScanned: number;
  /** Pairs that had at least two venues quoting, i.e. an arb was structurally possible. */
  pairsComparable: number;
  v3ScreenFailures: number;
  cyclesScreened: number;
  /** Screened cycles whose spot edge cleared the flash premium and got fully sized. */
  cyclesConfirmed: number;
  /** Confirmed cycles that priced out at zero or negative profit after impact. */
  cyclesUnprofitable: number;
  trianglesEnumerated: number;
  /** Venue quotes discarded as implausible against the oracle — dead/broken pools. */
  quotesImplausible: number;
  bestEdgeBps: number | null;
  bestEdgeRoute: string | null;
}

function newDiagnostics(): ScanDiagnostics {
  return {
    pairsScanned: 0,
    pairsComparable: 0,
    v3ScreenFailures: 0,
    cyclesScreened: 0,
    cyclesConfirmed: 0,
    cyclesUnprofitable: 0,
    trianglesEnumerated: 0,
    quotesImplausible: 0,
    bestEdgeBps: null,
    bestEdgeRoute: null,
  };
}

/**
 * Is a quoted `counterPerBase` rate consistent with independently-known USD
 * prices? Returns true when we cannot tell, so unpriced tokens are not silently
 * dropped — this is a filter for provably-broken data, not a liquidity opinion.
 */
function rateIsPlausible(
  observed: number,
  baseUsd: number,
  counterUsd: number,
): boolean {
  if (!(observed > 0) || !Number.isFinite(observed)) return false;
  if (!(baseUsd > 0) || !(counterUsd > 0)) return true;

  const expected = baseUsd / counterUsd;
  if (!(expected > 0) || !Number.isFinite(expected)) return true;

  const ratio = observed / expected;
  return ratio <= MAX_RATE_DEVIATION && ratio >= 1 / MAX_RATE_DEVIATION;
}

/** Record an observed cycle edge, keeping the best seen. Edge 1.0 == break-even. */
function recordEdge(diag: ScanDiagnostics, edge: number, route: string): void {
  if (!Number.isFinite(edge) || edge <= 0) return;
  const bps = (edge - 1) * 10_000;
  if (diag.bestEdgeBps === null || bps > diag.bestEdgeBps) {
    diag.bestEdgeBps = bps;
    diag.bestEdgeRoute = route;
  }
}

// ── leg construction ────────────────────────────────────────────────────────

function sameToken(a: TokenInfo, b: TokenInfo): boolean {
  return a.address.toLowerCase() === b.address.toLowerCase();
}

function poolHasToken(pool: Pool, token: TokenInfo): boolean {
  return sameToken(pool.tokenA, token) || sameToken(pool.tokenB, token);
}

function otherToken(pool: Pool, token: TokenInfo): TokenInfo {
  return sameToken(pool.tokenA, token) ? pool.tokenB : pool.tokenA;
}

function buildLeg(pool: Pool, tokenIn: TokenInfo): RouteLeg {
  const tokenOut = otherToken(pool, tokenIn);
  const aIsIn = sameToken(pool.tokenA, tokenIn);

  if (pool.kind === 'univ2') {
    return {
      venueId: pool.venueId,
      kind: 'univ2',
      router: pool.router,
      tokenIn,
      tokenOut,
      feeTier: 0,
      feeBps: pool.feeBps,
      pool: pool.pool,
      reserveIn: aIsIn ? pool.reserveA : pool.reserveB,
      reserveOut: aIsIn ? pool.reserveB : pool.reserveA,
    };
  }

  return {
    venueId: pool.venueId,
    kind: 'univ3',
    router: pool.router,
    tokenIn,
    tokenOut,
    feeTier: pool.feeTier,
    feeBps: pool.feeBps,
    pool: pool.pool,
  };
}

/**
 * Only stablecoins and the wrapped native token are treated as flash-borrowable.
 *
 * Two reasons: those are the assets lenders actually hold deep reserves of, and
 * restricting the base asset halves the number of orientations that need
 * screening. Borrowing an illiquid token to arbitrage it is not a real strategy.
 */
function isBorrowable(chainWrappedNative: string, token: TokenInfo): boolean {
  return !!token.stable || token.address.toLowerCase() === chainWrappedNative.toLowerCase();
}

/**
 * Fee-adjusted output-per-input for a locally-priced leg.
 * Multiplying this across a cycle gives the spot edge before price impact — a
 * near-free way to reject the vast majority of candidate routes.
 */
function legSpotRate(leg: RouteLeg): number {
  if (leg.reserveIn === undefined || leg.reserveOut === undefined) return 0;
  const inFloat = Number(leg.reserveIn) / 10 ** leg.tokenIn.decimals;
  const outFloat = Number(leg.reserveOut) / 10 ** leg.tokenOut.decimals;
  if (!(inFloat > 0) || !(outFloat > 0)) return 0;
  return (outFloat / inFloat) * (1 - leg.feeBps / 10_000);
}

/** Product of spot rates around a cycle. Above 1 means a spot-level edge exists. */
function cycleSpotEdge(legs: RouteLeg[]): number {
  let edge = 1;
  for (const leg of legs) {
    const rate = legSpotRate(leg);
    if (rate <= 0) return 0;
    edge *= rate;
  }
  return edge;
}

// ── phase 1: screening prices ───────────────────────────────────────────────

/** Fee-adjusted units of tokenOut per unit of tokenIn, from cached V2 reserves. */
function v2ScreenPrice(pool: V2Pool, tokenIn: TokenInfo): number {
  const aIsIn = sameToken(pool.tokenA, tokenIn);
  const reserveIn = aIsIn ? pool.reserveA : pool.reserveB;
  const reserveOut = aIsIn ? pool.reserveB : pool.reserveA;
  const tokenOut = otherToken(pool, tokenIn);
  if (reserveIn <= 0n || reserveOut <= 0n) return 0;

  const inFloat = Number(reserveIn) / 10 ** tokenIn.decimals;
  const outFloat = Number(reserveOut) / 10 ** tokenOut.decimals;
  if (inFloat <= 0) return 0;

  return (outFloat / inFloat) * (1 - pool.feeBps / 10_000);
}

/**
 * Probe every V3 pool for a pair in a single batched call, giving prices that
 * already include the pool fee and the impact of a realistic small trade.
 */
async function v3ScreenPrices(
  scan: ScanContext,
  pools: V3Pool[],
  tokenIn: TokenInfo,
  probeAmountIn: bigint,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (pools.length === 0 || probeAmountIn <= 0n) return prices;

  const requests: V3QuoteRequest[] = pools.map((pool) => ({
    quoter: pool.quoter,
    tokenIn,
    tokenOut: otherToken(pool, tokenIn),
    feeTier: pool.feeTier,
    amountIn: probeAmountIn,
  }));

  const quotes = await quoteV3Batch(scan.ctx, requests);

  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i];
    const quote = quotes[i];
    if (!pool || !quote || !quote.ok || quote.amountOut === 0n) continue;

    const inFloat = Number(quote.amountIn) / 10 ** quote.tokenIn.decimals;
    const outFloat = Number(quote.amountOut) / 10 ** quote.tokenOut.decimals;
    if (inFloat <= 0 || outFloat <= 0) continue;

    prices.set(`${pool.venueId}:${pool.pool.toLowerCase()}:${pool.feeTier}`, outFloat / inFloat);
  }

  return prices;
}

function poolId(pool: Pool): string {
  return pool.kind === 'univ3'
    ? `${pool.venueId}:${pool.pool.toLowerCase()}:${pool.feeTier}`
    : `${pool.venueId}:${pool.pool.toLowerCase()}`;
}

// ── phase 2: sizing ─────────────────────────────────────────────────────────

/** Quote one leg for many input amounts, batching V3 and computing V2 locally. */
async function quoteLegBatch(
  scan: ScanContext,
  leg: RouteLeg,
  amountsIn: bigint[],
): Promise<bigint[]> {
  if (leg.kind === 'univ2') {
    if (leg.reserveIn === undefined || leg.reserveOut === undefined) {
      return amountsIn.map(() => 0n);
    }
    return amountsIn.map((amountIn) =>
      getAmountOutV2(amountIn, leg.reserveIn as bigint, leg.reserveOut as bigint, leg.feeBps),
    );
  }

  const requests: V3QuoteRequest[] = amountsIn.map((amountIn) => ({
    quoter: quoterForLeg(scan, leg),
    tokenIn: leg.tokenIn,
    tokenOut: leg.tokenOut,
    feeTier: leg.feeTier,
    amountIn,
  }));

  const quotes = await quoteV3Batch(scan.ctx, requests);
  return quotes.map((q) => (q.ok ? q.amountOut : 0n));
}

function quoterForLeg(scan: ScanContext, leg: RouteLeg): string {
  const venue = scan.ctx.chain.venues.find((v) => v.id === leg.venueId);
  return venue?.quoter ?? '';
}

/**
 * Walk a mixed-venue cycle over a ladder of input sizes.
 * Costs one batched call per V3 leg, regardless of ladder width.
 */
async function quoteCycleLadder(
  scan: ScanContext,
  legs: RouteLeg[],
  amountsIn: bigint[],
): Promise<bigint[]> {
  let current = amountsIn;
  for (const leg of legs) {
    current = await quoteLegBatch(scan, leg, current);
    if (current.every((v) => v === 0n)) return current;
  }
  return current;
}

/** Upper bound on borrow size: config cap, tightened by V2 pool depth. */
function sizeBounds(
  scan: ScanContext,
  baseToken: TokenInfo,
  legs: RouteLeg[],
): { min: bigint; max: bigint } | undefined {
  const price = scan.oracle.usd(baseToken);
  if (price <= 0) return undefined;

  let min = toBigInt(scan.config.minTradeUsd / price, baseToken.decimals);
  let max = toBigInt(scan.config.maxTradeUsd / price, baseToken.decimals);
  if (min <= 0n || max <= min) return undefined;

  // Borrowing a large fraction of a shallow pool guarantees the price impact
  // eats the spread, so clamp to the depth actually available.
  const firstLeg = legs[0];
  if (firstLeg?.kind === 'univ2' && firstLeg.reserveIn !== undefined) {
    const depthCap = (firstLeg.reserveIn * BigInt(MAX_RESERVE_FRACTION_BPS)) / 10_000n;
    if (depthCap < max) max = depthCap;
  }

  if (max <= min) return undefined;
  return { min, max };
}

// ── opportunity assembly ────────────────────────────────────────────────────

function chooseFlashProvider(scan: ScanContext): { provider: FlashProvider; feeBps: number } {
  // Balancer V2 charges no flash-loan premium, so it is strictly cheaper when
  // the vault holds the asset. Aave is the fallback. If the vault is short of
  // liquidity the pre-send eth_call simulation will catch it.
  if (scan.ctx.chain.balancerVault) {
    return { provider: FlashProvider.Balancer, feeBps: BALANCER_FLASH_FEE_BPS };
  }
  return { provider: FlashProvider.Aave, feeBps: AAVE_FLASH_FEE_BPS };
}

async function assembleOpportunity(
  scan: ScanContext,
  baseToken: TokenInfo,
  legs: RouteLeg[],
): Promise<ArbOpportunity | undefined> {
  const bounds = sizeBounds(scan, baseToken, legs);
  if (!bounds) return undefined;

  const { provider, feeBps } = chooseFlashProvider(scan);

  let sized: { amountIn: bigint; amountOut: bigint; profit: bigint } | undefined;

  if (isLocallyPriceable(legs)) {
    // Exact optimum, no network round-trips.
    sized = optimalSize(legs, bounds.min, bounds.max, feeBps);
  } else {
    const ladder = sizeLadder(bounds.min, bounds.max, LADDER_STEPS);
    const outs = await quoteCycleLadder(scan, legs, ladder);
    sized = bestFromLadder(
      ladder.map((amountIn, i) => ({ amountIn, amountOut: outs[i] ?? 0n })),
      feeBps,
    );
  }

  if (!sized || sized.profit <= 0n) return undefined;

  const basePrice = scan.oracle.usd(baseToken);
  const nativePrice = scan.oracle.nativeUsd();
  if (basePrice <= 0 || nativePrice <= 0) return undefined;

  const grossProfitUsd = valueUsd(sized.profit, baseToken, basePrice);
  const gasUsd = gasCostUsd(scan.config.gasLimitEstimate, scan.gasPriceWei, nativePrice);
  const netProfitUsd = grossProfitUsd - gasUsd;

  const flashFeeAmount =
    feeBps > 0 ? (sized.amountIn * BigInt(feeBps)) / 10_000n : 0n;

  return {
    id: `${scan.ctx.chain.name}-${legs.map((l) => l.venueId).join('>')}-${Date.now()}`,
    chain: scan.ctx.chain.name,
    baseToken,
    legs,
    amountIn: sized.amountIn,
    amountOut: sized.amountOut,
    grossProfit: sized.profit,
    flashFee: flashFeeAmount,
    flashProvider: provider,
    notionalUsd: valueUsd(sized.amountIn, baseToken, basePrice),
    grossProfitUsd,
    gasCostUsd: gasUsd,
    netProfitUsd,
    discoveredAt: Date.now(),
  };
}

// ── two-leg cross-venue scanning ────────────────────────────────────────────

/**
 * Classic flash-loan arbitrage: borrow the base token, sell it where it fetches
 * the most of the counter token, buy it back where it is cheapest, repay.
 */
async function scanPair(
  scan: ScanContext,
  tokenX: TokenInfo,
  tokenY: TokenInfo,
  diag: ScanDiagnostics,
): Promise<ArbOpportunity[]> {
  diag.pairsScanned += 1;
  const candidates = poolsForPair(scan.pools, tokenX, tokenY);
  if (candidates.length < 2) return [];

  const opportunities: ArbOpportunity[] = [];
  const { feeBps: flashFeeBps } = chooseFlashProvider(scan);
  const requiredEdge = 1 + (flashFeeBps + SCREEN_MARGIN_BPS) / 10_000;

  // Only orientations whose base asset is genuinely flash-borrowable are worth
  // screening; this also halves the V3 quote traffic per pair.
  const baseCandidates = [tokenX, tokenY].filter((t) =>
    isBorrowable(scan.ctx.chain.wrappedNative, t),
  );

  for (const baseToken of baseCandidates) {
    const counterToken = sameToken(baseToken, tokenX) ? tokenY : tokenX;
    const basePrice = scan.oracle.usd(baseToken);
    if (basePrice <= 0) continue;

    const probeAmountIn = toBigInt(scan.config.minTradeUsd / basePrice, baseToken.decimals);
    if (probeAmountIn <= 0n) continue;

    const v3Pools = candidates.filter((p): p is V3Pool => p.kind === 'univ3');
    let v3Prices = new Map<string, number>();
    try {
      v3Prices = await v3ScreenPrices(scan, v3Pools, baseToken, probeAmountIn);
    } catch (err) {
      diag.v3ScreenFailures += 1;
      log.debug('v3 screen failed', { pair: `${tokenX.symbol}/${tokenY.symbol}`, ...errMeta(err) });
    }

    // Price of counterToken per baseToken, net of fees, on each venue.
    const counterPrice = scan.oracle.usd(counterToken);
    const priced: Array<{ pool: Pool; price: number }> = [];
    for (const pool of candidates) {
      if (!poolHasToken(pool, baseToken)) continue;
      const price =
        pool.kind === 'univ2'
          ? v2ScreenPrice(pool, baseToken)
          : (v3Prices.get(poolId(pool)) ?? 0);
      if (price <= 0) continue;

      // Discard provably-broken quotes before they can masquerade as an edge.
      if (!rateIsPlausible(price, basePrice, counterPrice)) {
        diag.quotesImplausible += 1;
        log.debug('discarding implausible quote', {
          pair: `${baseToken.symbol}/${counterToken.symbol}`,
          venue: pool.venueId,
          pool: pool.pool,
          observed: price,
          expected: counterPrice > 0 ? basePrice / counterPrice : null,
        });
        continue;
      }

      priced.push({ pool, price });
    }
    if (priced.length < 2) continue;
    diag.pairsComparable += 1;

    // Sell where we receive the most counter token, buy back where it is dearest
    // in base terms — i.e. the lowest counter-per-base price.
    let sellVenue = priced[0];
    let buyVenue = priced[0];
    for (const entry of priced) {
      if (!sellVenue || entry.price > sellVenue.price) sellVenue = entry;
      if (!buyVenue || entry.price < buyVenue.price) buyVenue = entry;
    }
    if (!sellVenue || !buyVenue) continue;
    if (poolId(sellVenue.pool) === poolId(buyVenue.pool)) continue;
    if (buyVenue.price <= 0) continue;

    diag.cyclesScreened += 1;
    const edge = sellVenue.price / buyVenue.price;
    recordEdge(
      diag,
      edge,
      `${baseToken.symbol}/${counterToken.symbol} ${sellVenue.pool.venueId}->${buyVenue.pool.venueId}`,
    );

    // Phase 1 gate: the fee-adjusted edge must at least cover the flash premium.
    if (edge < requiredEdge) continue;

    const legs: RouteLeg[] = [
      buildLeg(sellVenue.pool, baseToken),
      buildLeg(buyVenue.pool, counterToken),
    ];

    try {
      diag.cyclesConfirmed += 1;
      const opportunity = await assembleOpportunity(scan, baseToken, legs);
      if (opportunity) opportunities.push(opportunity);
      else diag.cyclesUnprofitable += 1;
    } catch (err) {
      log.debug('sizing failed', { pair: `${tokenX.symbol}/${tokenY.symbol}`, ...errMeta(err) });
    }
  }

  return opportunities;
}

// ── triangular scanning (V2 only, fully local) ──────────────────────────────

/**
 * Triangular cycles across V2 pools: base -> mid -> far -> base.
 *
 * Restricted to V2 because those are priced from cached reserves, making the
 * whole search free. Extending it to V3 would multiply quote traffic by the
 * number of triples, which is not worth it at this stage.
 */
async function scanTriangular(
  scan: ScanContext,
  baseToken: TokenInfo,
  diag: ScanDiagnostics,
): Promise<ArbOpportunity[]> {
  const v2 = scan.pools.v2;
  if (v2.length < 3) return [];

  const opportunities: ArbOpportunity[] = [];
  const firstHops = v2.filter((p) => poolHasToken(p, baseToken));
  const { feeBps: flashFeeBps } = chooseFlashProvider(scan);
  const requiredEdge = 1 + (flashFeeBps + SCREEN_MARGIN_BPS) / 10_000;

  for (const firstPool of firstHops) {
    const mid = otherToken(firstPool, baseToken);
    if (sameToken(mid, baseToken)) continue;

    for (const secondPool of v2) {
      if (poolId(secondPool) === poolId(firstPool)) continue;
      if (!poolHasToken(secondPool, mid)) continue;

      const far = otherToken(secondPool, mid);
      if (sameToken(far, baseToken) || sameToken(far, mid)) continue;

      for (const thirdPool of v2) {
        if (poolId(thirdPool) === poolId(firstPool)) continue;
        if (poolId(thirdPool) === poolId(secondPool)) continue;
        if (!poolHasToken(thirdPool, far) || !poolHasToken(thirdPool, baseToken)) continue;

        const legs: RouteLeg[] = [
          buildLeg(firstPool, baseToken),
          buildLeg(secondPool, mid),
          buildLeg(thirdPool, far),
        ];

        diag.trianglesEnumerated += 1;
        const edge = cycleSpotEdge(legs);
        recordEdge(diag, edge, `${baseToken.symbol}>${mid.symbol}>${far.symbol}`);

        // Cheap gate. Triangular enumeration is cubic in pool count, so running
        // the full optimal-sizing search on every triple would dominate the scan
        // budget. A spot-level edge product below the flash premium cannot
        // become profitable once price impact is added, so reject it for free.
        if (edge < requiredEdge) continue;

        try {
          diag.cyclesConfirmed += 1;
          const opportunity = await assembleOpportunity(scan, baseToken, legs);
          if (opportunity) opportunities.push(opportunity);
          else diag.cyclesUnprofitable += 1;
        } catch {
          // A dead triple is not worth logging at this volume.
        }
      }
    }
  }

  return opportunities;
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Run every strategy and return all positive-profit cycles, best first. */
async function scanChainAll(
  scan: ScanContext,
): Promise<{ found: ArbOpportunity[]; diag: ScanDiagnostics }> {
  const found: ArbOpportunity[] = [];
  const diag = newDiagnostics();

  // Two-leg cross-venue, over every configured pair.
  for (const [symbolX, symbolY] of scan.ctx.chain.pairs) {
    let tokenX: TokenInfo;
    let tokenY: TokenInfo;
    try {
      tokenX = tokenBySymbol(scan.ctx.chain, symbolX);
      tokenY = tokenBySymbol(scan.ctx.chain, symbolY);
    } catch {
      continue;
    }

    try {
      found.push(...(await scanPair(scan, tokenX, tokenY, diag)));
    } catch (err) {
      log.warn('pair scan failed', { pair: `${symbolX}/${symbolY}`, ...errMeta(err) });
    }
  }

  // Triangular, anchored on the wrapped native token and any stablecoin.
  const anchors = scan.ctx.chain.tokens.filter(
    (t) => t.stable || t.address.toLowerCase() === scan.ctx.chain.wrappedNative.toLowerCase(),
  );
  for (const anchor of anchors) {
    try {
      found.push(...(await scanTriangular(scan, anchor, diag)));
    } catch (err) {
      log.debug('triangular scan failed', { anchor: anchor.symbol, ...errMeta(err) });
    }
  }

  found.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
  return { found, diag };
}

/** Opportunities that clear the configured net-profit floor. */
export async function scanChain(scan: ScanContext): Promise<ArbOpportunity[]> {
  const { found } = await scanChainAll(scan);
  return found.filter((o) => o.netProfitUsd >= scan.config.minProfitUsd);
}

/**
 * Same scan, but also surfaces sub-threshold results and stage counters.
 *
 * Near misses distinguish "the market is efficient" from "our threshold is too
 * high"; the diagnostics distinguish both of those from "the scanner silently
 * filtered everything before pricing it", which is otherwise invisible.
 */
export async function scanChainVerbose(scan: ScanContext): Promise<{
  actionable: ArbOpportunity[];
  nearMisses: ArbOpportunity[];
  diagnostics: ScanDiagnostics;
}> {
  const { found, diag } = await scanChainAll(scan);
  return {
    actionable: found.filter((o) => o.netProfitUsd >= scan.config.minProfitUsd),
    nearMisses: found.filter((o) => o.netProfitUsd < scan.config.minProfitUsd).slice(0, 5),
    diagnostics: diag,
  };
}
