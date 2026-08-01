/**
 * Unified pool discovery across every configured venue on a chain.
 */

import { Interface } from 'ethers';
import { discoverV2Pools, refreshV2Reserves, v2LiquidityUsd } from './univ2';
import { discoverV3Pools } from './univ3';
import {
  discoverSolidlyPools,
  refreshSolidlyReserves,
  solidlyLiquidityUsd,
} from './solidly';
import { discoverCurvePools } from './curve';
import type { CurvePool, Pool, SolidlyPool, V2Pool, V3Pool } from './pools';
import { multicall, type Call, type ChainContext } from '../provider';
import { ERC20_ABI } from '../abi';
import { tokenBySymbol } from '../../chains';
import { createLogger, errMeta } from '../../logger';
import type { TokenInfo } from '../../types';

const log = createLogger('dex');

export * from './pools';
export * from './univ2';
export * from './univ3';
export * from './solidly';
export * from './curve';

export interface PoolSet {
  v2: V2Pool[];
  v3: V3Pool[];
  /** Aerodrome / Velodrome. Locally priceable, like v2. */
  solidly: SolidlyPool[];
  /** Curve StableSwap. Quoted on-chain, like v3. */
  curve: CurvePool[];
}

export function emptyPoolSet(): PoolSet {
  return { v2: [], v3: [], solidly: [], curve: [] };
}

/** Every pool in the set, regardless of family. */
export function allPools(pools: PoolSet): Pool[] {
  return [...pools.v2, ...pools.v3, ...pools.solidly, ...pools.curve];
}

/** Resolve the chain's configured symbol pairs into token pairs. */
function resolvePairs(ctx: ChainContext): Array<[TokenInfo, TokenInfo]> {
  const pairs: Array<[TokenInfo, TokenInfo]> = [];
  for (const [symbolA, symbolB] of ctx.chain.pairs) {
    try {
      pairs.push([tokenBySymbol(ctx.chain, symbolA), tokenBySymbol(ctx.chain, symbolB)]);
    } catch (err) {
      log.warn('skipping unresolvable pair', { pair: `${symbolA}/${symbolB}`, ...errMeta(err) });
    }
  }
  return pairs;
}

/**
 * Enumerate every pool ARBO will watch. Called once at startup — pool addresses
 * are immutable, only their state changes, so there is no reason to re-resolve
 * them on every scan.
 */
export async function discoverPools(ctx: ChainContext, enabledVenueIds?: Set<string>): Promise<PoolSet> {
  const pairs = resolvePairs(ctx);
  const v2: V2Pool[] = [];
  const v3: V3Pool[] = [];
  const solidly: SolidlyPool[] = [];
  const curve: CurvePool[] = [];

  // Curve pools are multi-asset, so discovery needs the whole token universe
  // rather than the configured pairs — a 3pool contributes pairs that were never
  // enumerated in config.
  const tokens = ctx.chain.tokens;

  for (const venue of ctx.chain.venues) {
    if (enabledVenueIds && !enabledVenueIds.has(venue.id)) continue;

    try {
      switch (venue.kind) {
        case 'univ2':
          v2.push(...(await discoverV2Pools(ctx, venue, pairs)));
          break;
        case 'univ3':
          v3.push(...(await discoverV3Pools(ctx, venue, pairs)));
          break;
        case 'solidly':
          solidly.push(...(await discoverSolidlyPools(ctx, venue, pairs)));
          break;
        case 'curve':
          curve.push(...(await discoverCurvePools(ctx, venue, tokens)));
          break;
      }
    } catch (err) {
      log.warn('pool discovery failed for venue', { venue: venue.id, ...errMeta(err) });
    }
  }

  log.info('pool discovery complete', {
    chain: ctx.chain.name,
    v2Pools: v2.length,
    v3Pools: v3.length,
    solidlyPools: solidly.length,
    solidlyStable: solidly.filter((p) => p.stable).length,
    curvePools: curve.length,
  });

  return { v2, v3, solidly, curve };
}

/**
 * Refresh mutable state for the locally-priceable families.
 *
 * V3 and Curve are priced on demand through their own quoters, so they have
 * nothing to cache and are passed through untouched.
 */
export async function refreshPools(
  ctx: ChainContext,
  pools: PoolSet,
  minLiquidityUsd = 0,
  priceOf?: (token: TokenInfo) => number,
): Promise<PoolSet> {
  const [refreshedV2, refreshedSolidly] = await Promise.all([
    refreshV2Reserves(ctx, pools.v2),
    refreshSolidlyReserves(ctx, pools.solidly),
  ]);

  const liveV2 = refreshedV2.filter(
    (p) => p.reserveA > 0n && p.reserveB > 0n && v2LiquidityUsd(p, priceOf) >= minLiquidityUsd,
  );
  const liveSolidly = refreshedSolidly.filter(
    (p) =>
      p.reserveA > 0n && p.reserveB > 0n && solidlyLiquidityUsd(p, priceOf) >= minLiquidityUsd,
  );

  return { v2: liveV2, v3: pools.v3, solidly: liveSolidly, curve: pools.curve };
}

/**
 * Measure how much value each V3 pool actually holds, and drop the dust.
 *
 * This matters more than it looks. Abandoned V3 pools exist at every fee tier
 * for every pair, and because arbitraging them costs more gas than they contain,
 * nobody ever corrects their price — one live Base WETH/DAI pool sat at 2.2x the
 * true rate, and a DAI/USDC pool quoted a rate 1e8 off. Fed into a scanner those
 * are not opportunities, they are phantoms that consume the entire quote budget
 * and produce edges of 100%+ that can never be filled.
 *
 * Token balance is a deliberately crude proxy for V3 depth — real depth depends
 * on where liquidity sits relative to spot — but it is exactly the right test for
 * the question being asked, which is "is this pool alive at all", and it costs
 * one batched multicall.
 */
export async function filterV3ByDepth(
  ctx: ChainContext,
  pools: V3Pool[],
  minLiquidityUsd: number,
  priceOf: (token: TokenInfo) => number,
): Promise<{ kept: V3Pool[]; dropped: number }> {
  if (pools.length === 0 || minLiquidityUsd <= 0) return { kept: pools, dropped: 0 };

  const erc20 = new Interface(ERC20_ABI);
  const calls: Call[] = [];
  for (const pool of pools) {
    calls.push({
      target: pool.tokenA.address,
      callData: erc20.encodeFunctionData('balanceOf', [pool.pool]),
    });
    calls.push({
      target: pool.tokenB.address,
      callData: erc20.encodeFunctionData('balanceOf', [pool.pool]),
    });
  }

  const results = await multicall(ctx, calls);

  const kept: V3Pool[] = [];
  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i];
    if (!pool) continue;

    const balA = results[i * 2];
    const balB = results[i * 2 + 1];

    // A pool we could not measure is kept rather than silently discarded; the
    // profit engine is the backstop, and dropping real venues on an RPC hiccup
    // would be the worse failure.
    if (!balA?.success || !balB?.success) {
      kept.push(pool);
      continue;
    }

    let depthUsd = 0;
    try {
      const amountA = BigInt(erc20.decodeFunctionResult('balanceOf', balA.returnData)[0]);
      const amountB = BigInt(erc20.decodeFunctionResult('balanceOf', balB.returnData)[0]);
      depthUsd =
        (Number(amountA) / 10 ** pool.tokenA.decimals) * priceOf(pool.tokenA) +
        (Number(amountB) / 10 ** pool.tokenB.decimals) * priceOf(pool.tokenB);
    } catch {
      kept.push(pool);
      continue;
    }

    if (depthUsd >= minLiquidityUsd) {
      kept.push(pool);
    } else {
      log.debug('dropping shallow v3 pool', {
        chain: ctx.chain.name,
        venue: pool.venueId,
        pair: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
        feeTier: pool.feeTier,
        depthUsd: Number(depthUsd.toFixed(0)),
      });
    }
  }

  return { kept, dropped: pools.length - kept.length };
}

/** All pools that trade the given unordered token pair. */
export function poolsForPair(pools: PoolSet, tokenA: TokenInfo, tokenB: TokenInfo): Pool[] {
  const a = tokenA.address.toLowerCase();
  const b = tokenB.address.toLowerCase();
  const matches = (pool: Pool): boolean => {
    const pa = pool.tokenA.address.toLowerCase();
    const pb = pool.tokenB.address.toLowerCase();
    return (pa === a && pb === b) || (pa === b && pb === a);
  };
  return allPools(pools).filter(matches);
}
