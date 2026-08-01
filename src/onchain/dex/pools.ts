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

export type Pool = V2Pool | V3Pool;

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
