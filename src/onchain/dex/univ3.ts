/**
 * Uniswap V3 adapter.
 *
 * V3 pricing depends on tick/liquidity distribution, which cannot be replicated
 * off-chain from a single storage read the way V2 reserves can. So instead of
 * local repricing, V3 legs are priced by asking QuoterV2 directly — batched
 * through Multicall3 to keep the round-trip count low.
 *
 * QuoterV2 reverts internally to unwind simulated state, so every quote must be
 * a staticCall and failures (no liquidity at that size) are expected and
 * tolerated rather than treated as errors.
 */

import { Interface } from 'ethers';
import { UNIV3_FACTORY_ABI, UNIV3_QUOTER_V2_ABI } from '../abi';
import { isZeroAddress, multicall, type ChainContext } from '../provider';
import { venueFeeBps, type V3Pool } from './pools';
import type { DexVenue, TokenInfo } from '../../types';
import { createLogger } from '../../logger';

const log = createLogger('dex:univ3');

const factoryIface = new Interface(UNIV3_FACTORY_ABI);
const quoterIface = new Interface(UNIV3_QUOTER_V2_ABI);

/** QuoterV2 simulations are gas-heavy; keep batches small so eth_call succeeds. */
const QUOTE_CHUNK_SIZE = 12;

/** Enumerate every (pair, feeTier) pool that actually exists. Run once at startup. */
export async function discoverV3Pools(
  ctx: ChainContext,
  venue: DexVenue,
  pairs: Array<[TokenInfo, TokenInfo]>,
): Promise<V3Pool[]> {
  if (!venue.factory || !venue.quoter) {
    log.warn('venue missing factory or quoter, skipping', { venue: venue.id });
    return [];
  }

  const feeTiers = venue.feeTiers ?? [500, 3000];
  const combos: Array<{ tokenA: TokenInfo; tokenB: TokenInfo; feeTier: number }> = [];
  for (const [tokenA, tokenB] of pairs) {
    for (const feeTier of feeTiers) {
      combos.push({ tokenA, tokenB, feeTier });
    }
  }

  const calls = combos.map((c) => ({
    target: venue.factory as string,
    callData: factoryIface.encodeFunctionData('getPool', [
      c.tokenA.address,
      c.tokenB.address,
      c.feeTier,
    ]),
  }));

  const results = await multicall(ctx, calls, 40);
  const pools: V3Pool[] = [];

  for (let i = 0; i < combos.length; i += 1) {
    const combo = combos[i];
    const result = results[i];
    if (!combo || !result || !result.success || result.returnData === '0x') continue;

    let address: string;
    try {
      address = factoryIface.decodeFunctionResult('getPool', result.returnData)[0] as string;
    } catch {
      continue;
    }
    if (isZeroAddress(address)) continue;

    pools.push({
      kind: 'univ3',
      venueId: venue.id,
      venueLabel: venue.label,
      router: venue.router,
      quoter: venue.quoter,
      pool: address,
      tokenA: combo.tokenA,
      tokenB: combo.tokenB,
      feeTier: combo.feeTier,
      feeBps: venueFeeBps(venue, combo.feeTier),
    });
  }

  log.debug('discovered pools', { venue: venue.id, chain: ctx.chain.name, count: pools.length });
  return pools;
}

export interface V3QuoteRequest {
  quoter: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  feeTier: number;
  amountIn: bigint;
}

export interface V3QuoteResult extends V3QuoteRequest {
  amountOut: bigint;
  /** False when the pool could not fill this size. */
  ok: boolean;
}

/** Batch-quote exact-input single-hop swaps. */
export async function quoteV3Batch(
  ctx: ChainContext,
  requests: V3QuoteRequest[],
): Promise<V3QuoteResult[]> {
  if (requests.length === 0) return [];

  const calls = requests.map((r) => ({
    target: r.quoter,
    callData: quoterIface.encodeFunctionData('quoteExactInputSingle', [
      [r.tokenIn.address, r.tokenOut.address, r.amountIn, r.feeTier, 0n],
    ]),
  }));

  const results = await multicall(ctx, calls, QUOTE_CHUNK_SIZE);

  return requests.map((request, i) => {
    const result = results[i];
    if (!result || !result.success || result.returnData === '0x') {
      return { ...request, amountOut: 0n, ok: false };
    }
    try {
      const decoded = quoterIface.decodeFunctionResult(
        'quoteExactInputSingle',
        result.returnData,
      );
      return { ...request, amountOut: BigInt(decoded[0] as bigint | string), ok: true };
    } catch {
      return { ...request, amountOut: 0n, ok: false };
    }
  });
}

/**
 * Implied price of tokenOut per tokenIn from a quote, decimal adjusted.
 * Includes the pool fee and the impact of that specific probe size, which is
 * exactly what we want for screening.
 */
export function impliedPrice(result: V3QuoteResult): number {
  if (!result.ok || result.amountOut === 0n || result.amountIn === 0n) return 0;
  const inFloat = Number(result.amountIn) / 10 ** result.tokenIn.decimals;
  const outFloat = Number(result.amountOut) / 10 ** result.tokenOut.decimals;
  if (inFloat <= 0) return 0;
  return outFloat / inFloat;
}
