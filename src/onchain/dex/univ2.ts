/**
 * Uniswap V2 (and fork) adapter.
 *
 * V2 is cheap to work with: one getReserves() call per pool gives us complete
 * pricing state, so once reserves are cached the entire optimal-sizing search
 * runs locally with zero further RPC traffic. This is why V2-only cycles are
 * the fast path.
 */

import { Interface } from 'ethers';
import { UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI } from '../abi';
import { isZeroAddress, multicall, type ChainContext } from '../provider';
import { isTokenAFirst, venueFeeBps, type V2Pool } from './pools';
import type { DexVenue, TokenInfo } from '../../types';
import { createLogger } from '../../logger';

const log = createLogger('dex:univ2');

const factoryIface = new Interface(UNIV2_FACTORY_ABI);
const pairIface = new Interface(UNIV2_PAIR_ABI);

/** Resolve pair addresses for the configured token pairs. Run once at startup. */
export async function discoverV2Pools(
  ctx: ChainContext,
  venue: DexVenue,
  pairs: Array<[TokenInfo, TokenInfo]>,
): Promise<V2Pool[]> {
  if (!venue.factory) {
    log.warn('venue has no factory configured, skipping', { venue: venue.id });
    return [];
  }

  const calls = pairs.map(([a, b]) => ({
    target: venue.factory as string,
    callData: factoryIface.encodeFunctionData('getPair', [a.address, b.address]),
  }));

  const results = await multicall(ctx, calls, 40);
  const pools: V2Pool[] = [];

  for (let i = 0; i < pairs.length; i += 1) {
    const entry = pairs[i];
    const result = results[i];
    if (!entry || !result || !result.success || result.returnData === '0x') continue;

    let address: string;
    try {
      address = factoryIface.decodeFunctionResult('getPair', result.returnData)[0] as string;
    } catch {
      continue;
    }
    if (isZeroAddress(address)) continue;

    const [tokenA, tokenB] = entry;
    pools.push({
      kind: 'univ2',
      venueId: venue.id,
      venueLabel: venue.label,
      router: venue.router,
      pool: address,
      tokenA,
      tokenB,
      feeBps: venueFeeBps(venue),
      reserveA: 0n,
      reserveB: 0n,
    });
  }

  log.debug('discovered pools', { venue: venue.id, chain: ctx.chain.name, count: pools.length });
  return pools;
}

/**
 * Refresh reserves for every pool in one batched call.
 * Pools that fail to respond are returned with zero reserves and get filtered
 * out downstream, rather than silently keeping stale prices.
 */
export async function refreshV2Reserves(ctx: ChainContext, pools: V2Pool[]): Promise<V2Pool[]> {
  if (pools.length === 0) return [];

  const calls = pools.map((p) => ({
    target: p.pool,
    callData: pairIface.encodeFunctionData('getReserves', []),
  }));

  const results = await multicall(ctx, calls, 60);

  return pools.map((pool, i) => {
    const result = results[i];
    if (!result || !result.success || result.returnData === '0x') {
      return { ...pool, reserveA: 0n, reserveB: 0n };
    }

    try {
      const decoded = pairIface.decodeFunctionResult('getReserves', result.returnData);
      const reserve0 = BigInt(decoded[0] as bigint | string);
      const reserve1 = BigInt(decoded[1] as bigint | string);
      const aIsToken0 = isTokenAFirst(pool.tokenA, pool.tokenB);
      return {
        ...pool,
        reserveA: aIsToken0 ? reserve0 : reserve1,
        reserveB: aIsToken0 ? reserve1 : reserve0,
      };
    } catch {
      return { ...pool, reserveA: 0n, reserveB: 0n };
    }
  });
}

/**
 * Spot price of tokenB per tokenA, decimal adjusted.
 * Used purely for the cheap cross-venue screening pass.
 */
export function v2SpotPrice(pool: V2Pool, aToB: boolean): number {
  if (pool.reserveA <= 0n || pool.reserveB <= 0n) return 0;

  const scaleA = 10 ** pool.tokenA.decimals;
  const scaleB = 10 ** pool.tokenB.decimals;
  const a = Number(pool.reserveA) / scaleA;
  const b = Number(pool.reserveB) / scaleB;
  if (a <= 0 || b <= 0) return 0;

  return aToB ? b / a : a / b;
}

/**
 * Reserve depth of a pool expressed in USD, for liquidity filtering.
 *
 * `priceOf` should come from the live oracle. The `usdHint` fallback exists only
 * for the first pass before any prices are derived, and is deliberately not
 * trusted otherwise: hints go stale (a $3000 ETH hint against a $1865 market is
 * a 60% error) and stablecoins carry no hint at all, which silently valued every
 * stable pool at zero and made this filter a no-op.
 */
export function v2LiquidityUsd(
  pool: V2Pool,
  priceOf?: (token: TokenInfo) => number,
): number {
  const priceFor = (token: TokenInfo): number => {
    const live = priceOf?.(token) ?? 0;
    if (live > 0) return live;
    return token.stable ? 1 : (token.usdHint ?? 0);
  };

  const priceA = priceFor(pool.tokenA);
  const priceB = priceFor(pool.tokenB);
  const a = (Number(pool.reserveA) / 10 ** pool.tokenA.decimals) * priceA;
  const b = (Number(pool.reserveB) / 10 ** pool.tokenB.decimals) * priceB;
  return a + b;
}
