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
import type { PoolActivityTracker } from './dirty';
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
  /**
   * Block this pass is quoting against. Used to age screen-price cache entries;
   * zero disables dirty-pool reuse and every pool is re-quoted.
   */
  block?: number;
  /** Log-derived pool activity. Absent means "assume everything changed". */
  activity?: PoolActivityTracker;
  /** Survives between passes; holds screen prices for pools that did not trade. */
  screenCache?: ScreenPriceCache;
  /**
   * When true, return every comparable cycle even if it is unprofitable. Used by
   * measurement tools that need to observe decay, not by the live scanner.
   */
  rawMode?: boolean;
}

/**
 * Screen prices for pools that have not traded since they were last quoted.
 *
 * Only the *screening* rate is cached — the cheap first-pass number used to
 * decide whether a pair is worth looking at. Confirmation always re-quotes at
 * the real trade size, and execution always re-simulates, so a stale entry can
 * cost a wasted confirmation but can never reach a transaction.
 *
 * Keyed by pool and input token because a pool's forward and reverse rates are
 * separate measurements; the whole point of quoting both is that one is not the
 * reciprocal of the other.
 */
export class ScreenPriceCache {
  private readonly prices = new Map<string, number>();

  private static key(pool: string, tokenIn: TokenInfo): string {
    return `${pool.toLowerCase()}:${tokenIn.address.toLowerCase()}`;
  }

  get(pool: string, tokenIn: TokenInfo): number | undefined {
    return this.prices.get(ScreenPriceCache.key(pool, tokenIn));
  }

  set(pool: string, tokenIn: TokenInfo, price: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    this.prices.set(ScreenPriceCache.key(pool, tokenIn), price);
  }

  get size(): number {
    return this.prices.size;
  }
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
  /** Screen quotes served from cache because the pool had not traded. */
  quotesReused: number;
  /** Screen quotes that actually hit the network this pass. */
  quotesFetched: number;
  bestEdgeBps: number | null;
  bestEdgeRoute: string | null;
  /** Best edge seen per route this pass, so quiet pairs stay visible. */
  edgeByRoute: Map<string, number>;
  /** Pairs skipped because FOCUS_PAIRS was set and this pair was not in it. */
  pairsSkippedByFocus: number;
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
    quotesReused: 0,
    quotesFetched: 0,
    bestEdgeBps: null,
    bestEdgeRoute: null,
    edgeByRoute: new Map(),
    pairsSkippedByFocus: 0,
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

  // Per-route bests as well as the chain-wide best. Without this a single busy
  // pair owns the headline number on every block and every other pair is
  // invisible — which is exactly how a thin-but-profitable stable route would
  // get overlooked in favour of a WETH pair that is merely the most active.
  const prior = diag.edgeByRoute.get(route);
  if (prior === undefined || bps > prior) diag.edgeByRoute.set(route, bps);
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
function cycleSpotEdge(legs: RouteLeg[], curveRates?: Map<string, number>): number {
  let edge = 1;
  for (const leg of legs) {
    // Curve has no local pricing model we trust, so its rate comes from the
    // pre-quoted batch rather than from reserves. A curve leg with no entry is
    // unpriceable this pass and kills the cycle rather than defaulting to
    // something optimistic.
    const rate =
      leg.kind === 'curve'
        ? leg.pool
          ? (curveRates?.get(curveLegKey(leg.pool, leg.tokenIn)) ?? 0)
          : 0
        : legSpotRate(leg);
    if (rate <= 0) return 0;
    edge *= rate;
  }
  return edge;
}

// ── phase 1: screening prices ───────────────────────────────────────────────

/** Directional key for a pre-quoted Curve rate: one pool, one input token. */
function curveLegKey(poolAddress: string, tokenIn: TokenInfo): string {
  return `${poolAddress.toLowerCase()}|${tokenIn.address.toLowerCase()}`;
}

/**
 * Quote every Curve pool in both directions in a single batched call.
 *
 * This exists to let Curve participate in triangular search. That search is
 * cubic in pool count, so anything needing a round-trip per candidate leg is
 * unaffordable — which is why Curve was excluded from it originally. Paying for
 * all directions up front turns that per-candidate RPC cost into one fixed
 * multicall per scan, after which Curve legs price from memory exactly like V2
 * reserves do.
 *
 * The economics justify the extra call: Curve stable pools charge 1-4 bps
 * against the 30 bps a V2 pool takes, and a three-leg cycle pays its fee three
 * times. That is the difference between a round trip that needs a 90 bps
 * dislocation to break even and one that needs about 10.
 */
async function curveSpotRates(
  scan: ScanContext,
  pools: CurvePool[],
): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  if (pools.length === 0) return rates;

  const requests: Array<{
    pool: CurvePool;
    aToB: boolean;
    amountIn: bigint;
    tokenIn: TokenInfo;
    tokenOut: TokenInfo;
  }> = [];

  for (const pool of pools) {
    for (const aToB of [true, false]) {
      const tokenIn = aToB ? pool.tokenA : pool.tokenB;
      const tokenOut = aToB ? pool.tokenB : pool.tokenA;
      const price = scan.oracle.usd(tokenIn);
      if (price <= 0) continue;
      const amountIn = toBigInt(scan.config.minTradeUsd / price, tokenIn.decimals);
      if (amountIn <= 0n) continue;
      requests.push({ pool, aToB, amountIn, tokenIn, tokenOut });
    }
  }
  if (requests.length === 0) return rates;

  const quotes = await quoteCurveBatch(
    scan.ctx,
    requests.map((r) => ({ pool: r.pool, aToB: r.aToB, amountIn: r.amountIn })),
  );

  for (let i = 0; i < requests.length; i += 1) {
    const req = requests[i];
    const amountOut = quotes[i];
    if (!req || amountOut === undefined || amountOut <= 0n) continue;
    const inFloat = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
    const outFloat = Number(amountOut) / 10 ** req.tokenOut.decimals;
    if (inFloat <= 0 || outFloat <= 0) continue;
    rates.set(curveLegKey(req.pool.pool, req.tokenIn), outFloat / inFloat);
  }

  return rates;
}

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

  if (!sized) return undefined;

  // Raw mode allows measurement tools to observe negative or zero-profit cycles.
  // The live scanner filters these out upstream; here we just need a complete
  // opportunity object to re-quote.
  const profitPositive = sized.profit > 0n;
  if (!scan.rawMode && !profitPositive) return undefined;

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
 * Does this pool need a fresh network quote, or will the cached one do?
 *
 * Answers "yes" for anything not provably unchanged: no tracker, no cache, a
 * tracker reporting the pool as touched, or a missing cache entry in either
 * direction. Both directions are required together because the pair is screened
 * on their product.
 */
function needsScreen(
  scan: ScanContext,
  pool: Pool,
  baseToken: TokenInfo,
  counterToken: TokenInfo,
): boolean {
  const { activity, screenCache, block } = scan;
  if (!activity || !screenCache || !block) return true;
  if (activity.needsRequote(pool.pool, block)) return true;
  if (screenCache.get(pool.pool, baseToken) === undefined) return true;
  if (screenCache.get(pool.pool, counterToken) === undefined) return true;
  return false;
}

function cachedScreen(scan: ScanContext, pool: Pool, tokenIn: TokenInfo): number {
  return scan.screenCache?.get(pool.pool, tokenIn) ?? 0;
}

/**
 * Store freshly-quoted screen prices and mark their pools clean.
 *
 * A pool is only marked clean when both directions came back. Marking a
 * half-quoted pool clean would make it look cached forever while having nothing
 * usable to serve, so it would silently drop out of every future scan.
 */
function absorbScreenQuotes(
  scan: ScanContext,
  pools: Pool[],
  baseToken: TokenInfo,
  counterToken: TokenInfo,
  forward: Map<string, number>,
  reverse: Map<string, number>,
): void {
  const { screenCache, activity, block } = scan;
  if (!screenCache) return;

  for (const pool of pools) {
    const id = poolId(pool);
    const fwd = forward.get(id);
    const rev = reverse.get(id);
    if (!(fwd && fwd > 0) || !(rev && rev > 0)) continue;

    screenCache.set(pool.pool, baseToken, fwd);
    screenCache.set(pool.pool, counterToken, rev);
    if (activity && block) activity.noteQuoted(pool.pool, block);
  }
}

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

    // Only pools that actually traded need re-quoting. Everything else keeps the
    // number from the last pass, which is not an approximation — a pool that
    // emitted no events did not change. See `onchain/dirty.ts` for why this is
    // safe to rely on and how it fails open.
    const v3Fresh = v3Pools.filter((p) => needsScreen(scan, p, baseToken, counterToken));
    const curveFresh = curvePools.filter((p) => needsScreen(scan, p, baseToken, counterToken));

    diag.quotesFetched += (v3Fresh.length + curveFresh.length) * 2;
    diag.quotesReused +=
      (v3Pools.length - v3Fresh.length + curvePools.length - curveFresh.length) * 2;

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
    if (v3Fresh.length > 0) {
      try {
        [v3Fwd, v3Rev] = await Promise.all([
          v3ScreenPrices(scan, v3Fresh, baseToken, probeAmountIn),
          v3ScreenPrices(scan, v3Fresh, counterToken, probeCounterIn),
        ]);
      } catch (err) {
        diag.v3ScreenFailures += 1;
        log.debug('v3 screen failed', { pair: `${tokenX.symbol}/${tokenY.symbol}`, ...errMeta(err) });
      }
    }

    // Curve has no local math we trust, so it is probed on-chain exactly like V3.
    let curveFwd = new Map<string, number>();
    let curveRev = new Map<string, number>();
    if (curveFresh.length > 0) {
      try {
        [curveFwd, curveRev] = await Promise.all([
          curveScreenPrices(scan, curveFresh, baseToken, probeAmountIn),
          curveScreenPrices(scan, curveFresh, counterToken, probeCounterIn),
        ]);
      } catch (err) {
        diag.v3ScreenFailures += 1;
        log.debug('curve screen failed', {
          pair: `${tokenX.symbol}/${tokenY.symbol}`,
          ...errMeta(err),
        });
      }
    }

    // Fold fresh quotes into the cache and mark those pools clean. Only pools
    // that produced *both* directions are marked: a half-quoted pool has no
    // usable cache entry, so calling it clean would strand it permanently.
    absorbScreenQuotes(scan, v3Fresh, baseToken, counterToken, v3Fwd, v3Rev);
    absorbScreenQuotes(scan, curveFresh, baseToken, counterToken, curveFwd, curveRev);

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
        forward = curveFwd.get(poolId(pool)) ?? cachedScreen(scan, pool, baseToken);
        reverse = curveRev.get(poolId(pool)) ?? cachedScreen(scan, pool, counterToken);
      } else {
        forward = v3Fwd.get(poolId(pool)) ?? cachedScreen(scan, pool, baseToken);
        reverse = v3Rev.get(poolId(pool)) ?? cachedScreen(scan, pool, counterToken);
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
    // In raw mode this gate is bypassed so measurement tools can observe decay
    // on cycles that look promising at the screen stage but fail confirmation.
    if (!scan.rawMode && edge < requiredEdge) continue;

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

// ── triangular scanning (locally-priced venues) ─────────────────────────────

/**
 * Triangular cycles: base -> mid -> far -> base.
 *
 * Enumeration is cubic in pool count, so it is restricted to pools that can be
 * priced in-process. V2 and Solidly qualify natively — both are exact local
 * integer math. Curve qualifies by proxy: its pools are few enough that every
 * direction can be quoted in one batched call before the loops start, after
 * which its legs cost nothing to screen. V3 is still excluded; there are far
 * too many pools for that trick to stay cheap.
 *
 * Including Curve matters because a triangle pays three fees. Three V2 legs
 * need a 90 bps dislocation before they break even, which effectively never
 * happens on a liquid pair. Three stable-pool legs need roughly 10.
 */
async function scanTriangular(
  scan: ScanContext,
  baseToken: TokenInfo,
  diag: ScanDiagnostics,
): Promise<ArbOpportunity[]> {
  const local: Array<V2Pool | SolidlyPool | CurvePool> = [
    ...scan.pools.v2,
    ...scan.pools.solidly,
    ...scan.pools.curve,
  ];
  if (local.length < 3) return [];

  // One batched call, before any enumeration, so Curve legs price from memory.
  // Failing here degrades to the previous behaviour rather than the scan: with
  // an empty map every Curve leg scores zero and its cycles drop out.
  let curveRates = new Map<string, number>();
  if (scan.pools.curve.length > 0) {
    try {
      curveRates = await curveSpotRates(scan, scan.pools.curve);
    } catch (err) {
      log.debug('curve spot pre-quote failed', { anchor: baseToken.symbol, ...errMeta(err) });
    }
  }

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
        const edge = cycleSpotEdge(legs, curveRates);
        recordEdge(
          diag,
          edge,
          `${baseToken.symbol}>${mid.symbol}>${far.symbol} ` +
            `${firstPool.venueId}>${secondPool.venueId}>${thirdPool.venueId}`,
        );

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

  // Two-leg cross-venue, over every configured pair (or the focused subset).
  const focus = scan.config.focusPairs
    ? new Set(
        scan.config.focusPairs
          .filter((f) => f.chain === scan.ctx.chain.name)
          .map((f) => `${f.pair[0]}/${f.pair[1]}`),
      )
    : undefined;

  for (const [symbolX, symbolY] of scan.ctx.chain.pairs) {
    if (focus && !focus.has(`${symbolX}/${symbolY}`) && !focus.has(`${symbolY}/${symbolX}`)) {
      diag.pairsSkippedByFocus += 1;
      continue;
    }

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
  // Focus mode disables triangles unless one of the triangle legs matches a
  // focused pair; otherwise we keep doing expensive work on pairs the user
  // explicitly excluded.
  const anchors = scan.ctx.chain.tokens.filter(
    (t) => t.stable || t.address.toLowerCase() === scan.ctx.chain.wrappedNative.toLowerCase(),
  );
  if (!focus) {
    for (const anchor of anchors) {
      try {
        found.push(...(await scanTriangular(scan, anchor, diag)));
      } catch (err) {
        log.debug('triangular scan failed', { anchor: anchor.symbol, ...errMeta(err) });
      }
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
