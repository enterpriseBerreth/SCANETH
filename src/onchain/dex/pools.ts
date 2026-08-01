/**
 * Pool snapshot model shared by every DEX adapter.
 */

import type { DexVenue, TokenInfo } from '../../types';

export interface BasePool {
  venueId: string;
  venueLabel: string;
  router: string;
  pool: string;
  tokenA: TokenInfo;
  tokenB: TokenInfo;
}

export interface V2Pool extends BasePool {
  kind: 'univ2';
  feeBps: number;
  /** Reserve of tokenA. Refreshed every scan. */
  reserveA: bigint;
  /** Reserve of tokenB. Refreshed every scan. */
  reserveB: bigint;
}

export interface V3Pool extends BasePool {
  kind: 'univ3';
  quoter: string;
  feeTier: number;
  feeBps: number;
  /** Last observed probe quote, used for the cheap screening pass. */
  probeAmountIn?: bigint;
  probeAmountOut?: bigint;
  probeDirectionAToB?: boolean;
}

/**
 * Solidly-family pool (Aerodrome, Velodrome).
 *
 * `stable` selects between `x·y = k` and `x³y + y³x = k`. It is not a hint — the
 * two curves produce very different quotes from identical reserves, and picking
 * the wrong one returns a plausible number rather than an error.
 */
export interface SolidlyPool extends BasePool {
  kind: 'solidly';
  stable: boolean;
  /** Read from the factory per pool, not assumed from the venue. */
  feeBps: number;
  reserveA: bigint;
  reserveB: bigint;
  /** 10**decimals, required to normalise the stable curve to 1e18. */
  scaleA: bigint;
  scaleB: bigint;
}

/**
 * Curve StableSwap pool.
 *
 * Quoted on-chain via `get_dy`, so no reserves are cached — only what is needed
 * to address the right pair of coins inside a multi-asset pool.
 */
export interface CurvePool extends BasePool {
  kind: 'curve';
  /** Coin index of tokenA within the pool. */
  indexA: number;
  /** Coin index of tokenB within the pool. */
  indexB: number;
  /** True when the pool declares indices as int128 rather than uint256. */
  int128Indices: boolean;
  feeBps: number;
  /** Last observed probe quote, used for the cheap screening pass. */
  probeAmountIn?: bigint;
  probeAmountOut?: bigint;
  probeDirectionAToB?: boolean;
}

export type Pool = V2Pool | V3Pool | SolidlyPool | CurvePool;

/**
 * Whether a pool's quotes can be recomputed in-process from cached state.
 *
 * This is the distinction that decides scan cost. Locally-priceable pools can be
 * re-quoted hundreds of times during optimal-size search for free; the rest need
 * a batched RPC round trip per candidate size, so they are screened first and
 * confirmed on a size ladder instead.
 */
export function isPoolLocallyPriceable(pool: Pool): boolean {
  return pool.kind === 'univ2' || pool.kind === 'solidly';
}

/**
 * Uniswap V2 factories store reserves against the address-sorted token pair,
 * so ordering can be derived locally instead of spending an extra token0() call
 * on every pool.
 */
export function isTokenAFirst(tokenA: TokenInfo, tokenB: TokenInfo): boolean {
  return tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
}

/** A stable key so the same pool is never double-counted across venues. */
export function poolKey(pool: Pool): string {
  return `${pool.venueId}:${pool.pool.toLowerCase()}`;
}

export function venueFeeBps(venue: DexVenue, feeTier?: number): number {
  if (venue.kind === 'univ3') {
    // V3 fee tiers are expressed in hundredths of a bip: 3000 -> 30 bps.
    return (feeTier ?? 3000) / 100;
  }
  return venue.feeBps ?? 30;
}
