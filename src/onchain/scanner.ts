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
import type { CurvePool, Pool, PoolSet, SolidlyPool, V2Pool, V3Pool } from './dex';
import { poolsForPair } from './dex';
import { quoteV3Batch, type V3QuoteRequest } from './dex/univ3';
import { getAmountOutSolidly } from './dex/solidly';
import { quoteCurveBatch } from './dex/curve';
import { PriceOracle } from './prices';
import {
  bestFromLadder,
  gasCostUsd,
  estimateRouteGas,
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

  if (pool.kind === 'solidly') {
    return {
      venueId: pool.venueId,
      kind: 'solidly',
      router: pool.router,
      tokenIn,
      tokenOut,
      feeTier: 0,
      feeBps: pool.feeBps,
      pool: pool.pool,
      reserveIn: aIsIn ? pool.reserveA : pool.reserveB,
      reserveOut: aIsIn ? pool.reserveB : pool.reserveA,
      // Carried explicitly rather than looked up later: the stable flag and the
      // decimal scales are what select the curve, and a leg that loses them
      // would price on the wrong one without erroring.
      stable: pool.stable,
      scaleIn: aIsIn ? pool.scaleA : pool.scaleB,
      scaleOut: aIsIn ? pool.scaleB : pool.scaleA,
    };
  }

  if (pool.kind === 'curve') {
    return {
      venueId: pool.venueId,
      kind: 'curve',
      router: pool.router,
      tokenIn,
      tokenOut,
      feeTier: 0,
      feeBps: pool.feeBps,
      pool: pool.pool,
      curveIndexIn: aIsIn ? pool.indexA : pool.indexB,
      curveIndexOut: aIsIn ? pool.indexB : pool.indexA,
      curveInt128: pool.int128Indices,
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

  if (leg.kind === 'solidly' && leg.stable) {
    // The reserve ratio is a bad proxy for marginal price on the stable curve —
    // its flatness near the peg is exactly the property being traded, so a ratio
    // would rank these pools by the wrong number and discard the useful ones.
    // Quote a 1% probe through the real curve instead; still free, still local.
    const scaleIn = leg.scaleIn ?? 10n ** BigInt(leg.tokenIn.decimals);
    const scaleOut = leg.scaleOut ?? 10n ** BigInt(leg.tokenOut.decimals);
    const probe = scaleIn / 100n > 0n ? scaleIn / 100n : 1n;
    const out = getAmountOutSolidly(
      probe,
      leg.reserveIn,
      leg.reserveOut,
      scaleIn,
      scaleOut,
      leg.feeBps,
      true,
    );
    if (out <= 0n) return 0;
    const inFloat = Number(probe) / Number(scaleIn);
    const outFloat = Number(out) / Number(scaleOut);
    return inFloat > 0 ? outFloat / inFloat : 0;
  }

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

/**
 * Screening price for a Solidly pool, from the local integer curve math.
 *
 * Deliberately quotes a real probe trade rather than reading the reserve ratio.
 * On the stable curve the ratio is nearly useless — the curve is flat by design
 * near the peg — so ranking pools by ratio would discard exactly the pools worth
 * trading. This is still free: no RPC, same fast path as V2.
 */
function solidlyScreenPrice(pool: SolidlyPool, tokenIn: TokenInfo, probeAmountIn: bigint): number {
  if (probeAmountIn <= 0n) return 0;
  const aIsIn = sameToken(pool.tokenA, tokenIn);
  const reserveIn = aIsIn ? pool.reserveA : pool.reserveB;
  const reserveOut = aIsIn ? pool.reserveB : pool.reserveA;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0;

  const scaleIn = aIsIn ? pool.scaleA : pool.scaleB;
  const scaleOut = aIsIn ? pool.scaleB : pool.scaleA;
  const amountOut = getAmountOutSolidly(
    probeAmountIn,
    reserveIn,
    reserveOut,
    scaleIn,
    scaleOut,
    pool.feeBps,
    pool.stable,
  );
  if (amountOut <= 0n) return 0;

  const tokenOut = otherToken(pool, tokenIn);
  const inFloat = Number(probeAmountIn) / 10 ** tokenIn.decimals;
  const outFloat = Number(amountOut) / 10 ** tokenOut.decimals;
  if (inFloat <= 0 || outFloat <= 0) return 0;
  return outFloat / inFloat;
}

/**
 * Probe every Curve pool for a pair in one batched call.
 *
 * Curve's `get_dy` already nets the pool fee, so unlike V2 no fee adjustment is
 * applied here — doing so would double-charge it.
 */
async function curveScreenPrices(
  scan: ScanContext,
  pools: CurvePool[],
  tokenIn: TokenInfo,
  probeAmountIn: bigint,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (pools.length === 0 || probeAmountIn <= 0n) return prices;

  const quotes = await quoteCurveBatch(
    scan.ctx,
    pools.map((pool) => ({
      pool,
      aToB: sameToken(pool.tokenA, tokenIn),
      amountIn: probeAmountIn,
    })),
  );

  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i];
    const amountOut = quotes[i];
    if (!pool || amountOut === undefined || amountOut <= 0n) continue;

    const tokenOut = otherToken(pool, tokenIn);
    const inFloat = Number(probeAmountIn) / 10 ** tokenIn.decimals;
    const outFloat = Number(amountOut) / 10 ** tokenOut.decimals;
    if (inFloat <= 0 || outFloat <= 0) continue;

    prices.set(`${pool.venueId}:${pool.pool.toLowerCase()}`, outFloat / inFloat);
  }

  return prices;
}

function poolId(pool: Pool): string {
  return pool.kind === 'univ3'
    ? `${pool.venueId}:${pool.pool.toLowerCase()}:${pool.feeTier}`
    : `${pool.venueId}:${pool.pool.toLowerCase()}`;
}

// ── phase 2: sizing ─────────────────────────────────────────────────────────

/** Quote one leg for many input amounts, computing locally where possible. */
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

  if (leg.kind === 'solidly') {
    if (leg.reserveIn === undefined || leg.reserveOut === undefined) {
      return amountsIn.map(() => 0n);
    }
    const scaleIn = leg.scaleIn ?? 10n ** BigInt(leg.tokenIn.decimals);
    const scaleOut = leg.scaleOut ?? 10n ** BigInt(leg.tokenOut.decimals);
    return amountsIn.map((amountIn) =>
      getAmountOutSolidly(
        amountIn,
        leg.reserveIn as bigint,
        leg.reserveOut as bigint,
        scaleIn,
        scaleOut,
        leg.feeBps,
        leg.stable === true,
      ),
    );
  }

  if (leg.kind === 'curve') {
    if (leg.pool === undefined || leg.curveIndexIn === undefined || leg.curveIndexOut === undefined) {
      return amountsIn.map(() => 0n);
    }
    const pool = scan.pools.curve.find(
      (p) => p.pool.toLowerCase() === (leg.pool as string).toLowerCase(),
    );
    if (!pool) return amountsIn.map(() => 0n);

    const quotes = await quoteCurveBatch(
      scan.ctx,
      amountsIn.map((amountIn) => ({
        pool,
        aToB: sameToken(pool.tokenA, leg.tokenIn),
        amountIn,
      })),
    );
    return quotes.map((q) => q ?? 0n);
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
  if (
    (firstLeg?.kind === 'univ2' || firstLeg?.kind === 'solidly') &&
    firstLeg.reserveIn !== undefined
  ) {
    const depthCap = (firstLeg.reserveIn * BigInt(MAX_RESERVE_FRACTION_BPS)) / 10_000n;
    if (depthCap < max) max = depthCap;
  }

  if (max <= min) return undefined;
  return { min, max };
}

/**
 * Re-price an existing route at a fixed size against current state.
 *
 * This is the settlement primitive for paper trading. It deliberately takes the
 * size as given rather than re-optimising it: the question being asked is "what
 * would the trade I already decided on have actually returned", and re-sizing
 * would quietly answer a different, more flattering question.
 *
 * V2 legs must have their reserves rebound to the live pool set first — the leg
 * objects carry a snapshot from discovery time, and re-quoting against a stale
 * snapshot would report zero decay by construction.
 */
export async function requoteCycle(
  scan: ScanContext,
  legs: RouteLeg[],
  amountIn: bigint,
): Promise<{ amountOut: bigint; quoted: boolean }> {
  if (amountIn <= 0n) return { amountOut: 0n, quoted: false };

  const rebound = rebindReserves(scan.pools, legs);
  if (!rebound) return { amountOut: 0n, quoted: false };

  const outs = await quoteCycleLadder(scan, rebound, [amountIn]);
  const amountOut = outs[0] ?? 0n;
  return { amountOut, quoted: amountOut > 0n };
}

/**
 * Replace cached V2 reserves with current ones, by pool address.
 * Returns undefined if any V2 leg's pool has left the working set, which means
 * the route is no longer tradeable and should settle as dead.
 *
 * Exported for testing: if this silently failed, every paper trade would settle
 * as dead and the ledger would report a 0% fill rate that meant nothing.
 */
export function rebindReserves(pools: PoolSet, legs: RouteLeg[]): RouteLeg[] | undefined {
  const v2ByAddress = new Map<string, V2Pool>();
  for (const pool of pools.v2) v2ByAddress.set(pool.pool.toLowerCase(), pool);
  const solidlyByAddress = new Map<string, SolidlyPool>();
  for (const pool of pools.solidly) solidlyByAddress.set(pool.pool.toLowerCase(), pool);

  const rebound: RouteLeg[] = [];
  for (const leg of legs) {
    if (leg.kind === 'univ3' || leg.kind === 'curve') {
      // Quoted live against the pool contract, so there is nothing to refresh.
      rebound.push(leg);
      continue;
    }

    if (leg.kind === 'solidly') {
      const fresh = leg.pool ? solidlyByAddress.get(leg.pool.toLowerCase()) : undefined;
      if (!fresh) return undefined;
      const aIsIn = sameToken(fresh.tokenA, leg.tokenIn);
      rebound.push({
        ...leg,
        reserveIn: aIsIn ? fresh.reserveA : fresh.reserveB,
        reserveOut: aIsIn ? fresh.reserveB : fresh.reserveA,
        // Re-read from the live pool: a governance fee change between detection
        // and settlement would otherwise be priced at the stale rate.
        feeBps: fresh.feeBps,
        stable: fresh.stable,
        scaleIn: aIsIn ? fresh.scaleA : fresh.scaleB,
        scaleOut: aIsIn ? fresh.scaleB : fresh.scaleA,
      });
      continue;
    }

    const fresh = leg.pool ? v2ByAddress.get(leg.pool.toLowerCase()) : undefined;
    if (!fresh) return undefined;

    const aIsIn = sameToken(fresh.tokenA, leg.tokenIn);
    rebound.push({
      ...leg,
      reserveIn: aIsIn ? fresh.reserveA : fresh.reserveB,
      reserveOut: aIsIn ? fresh.reserveB : fresh.reserveA,
    });
  }
  return rebound;
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
  // Costed on the actual shape of this route rather than one flat constant —
  // a 2-leg V2 cycle and a 3-leg V3 cycle are not the same trade.
  const gasUnits = estimateRouteGas(legs, provider === FlashProvider.Balancer);
  const gasUsd = gasCostUsd(gasUnits, scan.gasPriceWei, nativePrice);
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
    gasUnits,
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

    const counterPrice = scan.oracle.usd(counterToken);
    if (counterPrice <= 0) continue;
    const probeCounterIn = toBigInt(scan.config.minTradeUsd / counterPrice, counterToken.decimals);
    if (probeCounterIn <= 0n) continue;

    const v3Pools = candidates.filter((p): p is V3Pool => p.kind === 'univ3');
    const curvePools = candidates.filter((p): p is CurvePool => p.kind === 'curve');

    // Both directions are quoted, never derived by reciprocal.
    //
    // The second leg of the cycle trades counter -> base, so it needs a real
    // counter -> base quote. Using 1 / (base -> counter) instead is wrong in a
    // consistently optimistic direction: in a thin pool the forward quote is
    // heavily slipped, its reciprocal therefore looks like an excellent place to
    // buy back, and the pool manufactures a large phantom edge. Measuring both
    // directions costs one extra batched multicall per pair and removes an entire
    // class of false positive that was consuming the whole confirmation budget.
    let v3Fwd = new Map<string, number>();
    let v3Rev = new Map<string, number>();
    try {
      [v3Fwd, v3Rev] = await Promise.all([
        v3ScreenPrices(scan, v3Pools, baseToken, probeAmountIn),
        v3ScreenPrices(scan, v3Pools, counterToken, probeCounterIn),
      ]);
    } catch (err) {
      diag.v3ScreenFailures += 1;
      log.debug('v3 screen failed', { pair: `${tokenX.symbol}/${tokenY.symbol}`, ...errMeta(err) });
    }

    // Curve has no local math we trust, so it is probed on-chain exactly like V3.
    let curveFwd = new Map<string, number>();
    let curveRev = new Map<string, number>();
    try {
      [curveFwd, curveRev] = await Promise.all([
        curveScreenPrices(scan, curvePools, baseToken, probeAmountIn),
        curveScreenPrices(scan, curvePools, counterToken, probeCounterIn),
      ]);
    } catch (err) {
      diag.v3ScreenFailures += 1;
      log.debug('curve screen failed', {
        pair: `${tokenX.symbol}/${tokenY.symbol}`,
        ...errMeta(err),
      });
    }

    // `forward` is counter-per-base; `reverse` is base-per-counter. Both are
    // measured, so their product is the true round-trip rate.
    const priced: Array<{ pool: Pool; forward: number; reverse: number }> = [];
    for (const pool of candidates) {
      if (!poolHasToken(pool, baseToken)) continue;
      let forward: number;
      let reverse: number;
      if (pool.kind === 'univ2') {
        forward = v2ScreenPrice(pool, baseToken);
        reverse = v2ScreenPrice(pool, counterToken);
      } else if (pool.kind === 'solidly') {
        forward = solidlyScreenPrice(pool, baseToken, probeAmountIn);
        reverse = solidlyScreenPrice(pool, counterToken, probeCounterIn);
      } else if (pool.kind === 'curve') {
        forward = curveFwd.get(poolId(pool)) ?? 0;
        reverse = curveRev.get(poolId(pool)) ?? 0;
      } else {
        forward = v3Fwd.get(poolId(pool)) ?? 0;
        reverse = v3Rev.get(poolId(pool)) ?? 0;
      }
      if (forward <= 0 || reverse <= 0) continue;

      // Discard provably-broken quotes before they can masquerade as an edge.
      if (
        !rateIsPlausible(forward, basePrice, counterPrice) ||
        !rateIsPlausible(reverse, counterPrice, basePrice)
      ) {
        diag.quotesImplausible += 1;
        log.debug('discarding implausible quote', {
          pair: `${baseToken.symbol}/${counterToken.symbol}`,
          venue: pool.venueId,
          pool: pool.pool,
          forward,
          reverse,
          expected: counterPrice > 0 ? basePrice / counterPrice : null,
        });
        continue;
      }

      priced.push({ pool, forward, reverse });
    }
    if (priced.length < 2) continue;
    diag.pairsComparable += 1;

    // Maximise forward(sell) * reverse(buy) over distinct pools. The two factors
    // are independent, so the best pair is the best of each — unless that is the
    // same pool, in which case the runner-up on one side must be considered.
    let bestSell = priced[0];
    let bestBuy = priced[0];
    for (const entry of priced) {
      if (!bestSell || entry.forward > bestSell.forward) bestSell = entry;
      if (!bestBuy || entry.reverse > bestBuy.reverse) bestBuy = entry;
    }
    if (!bestSell || !bestBuy) continue;

    let sellVenue = bestSell;
    let buyVenue = bestBuy;
    if (poolId(bestSell.pool) === poolId(bestBuy.pool)) {
      let altSell: (typeof priced)[number] | undefined;
      let altBuy: (typeof priced)[number] | undefined;
      for (const entry of priced) {
        if (poolId(entry.pool) === poolId(bestSell.pool)) continue;
        if (!altSell || entry.forward > altSell.forward) altSell = entry;
        if (!altBuy || entry.reverse > altBuy.reverse) altBuy = entry;
      }
      if (!altSell || !altBuy) continue;

      // Whichever substitution loses less.
      if (altSell.forward * bestBuy.reverse >= bestSell.forward * altBuy.reverse) {
        sellVenue = altSell;
        buyVenue = bestBuy;
      } else {
        sellVenue = bestSell;
        buyVenue = altBuy;
      }
    }
    if (poolId(sellVenue.pool) === poolId(buyVenue.pool)) continue;

    diag.cyclesScreened += 1;
    const edge = sellVenue.forward * buyVenue.reverse;
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
  // Triangular enumeration is cubic in pool count, so it is restricted to pools
  // that can be priced in-process for free. Solidly qualifies alongside V2: both
  // are exact local integer math. V3 and Curve are excluded on purpose — each
  // triple would cost an RPC round-trip just to be screened, and at cubic volume
  // that would consume the entire scan budget before finding anything.
  const local: Array<V2Pool | SolidlyPool> = [...scan.pools.v2, ...scan.pools.solidly];
  if (local.length < 3) return [];

  const opportunities: ArbOpportunity[] = [];
  const firstHops = local.filter((p) => poolHasToken(p, baseToken));
  const { feeBps: flashFeeBps } = chooseFlashProvider(scan);
  const requiredEdge = 1 + (flashFeeBps + SCREEN_MARGIN_BPS) / 10_000;

  for (const firstPool of firstHops) {
    const mid = otherToken(firstPool, baseToken);
    if (sameToken(mid, baseToken)) continue;

    for (const secondPool of local) {
      if (poolId(secondPool) === poolId(firstPool)) continue;
      if (!poolHasToken(secondPool, mid)) continue;

      const far = otherToken(secondPool, mid);
      if (sameToken(far, baseToken) || sameToken(far, mid)) continue;

      for (const thirdPool of local) {
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
