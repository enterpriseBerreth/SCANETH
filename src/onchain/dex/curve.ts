/**
 * Curve StableSwap adapter.
 *
 * Curve matters here for the same structural reason Solidly's stable pools do: its
 * invariant is a blend of constant-sum and constant-product, tuned by an
 * amplification coefficient. Near the peg it behaves almost like constant-sum, so
 * it prices correlated assets on a fundamentally different curve from Uniswap V3's
 * concentrated ticks. The two disagree by construction, continuously.
 *
 * Unlike Solidly, this adapter does **not** port the maths locally, and that is a
 * considered decision rather than a shortcut. Curve has many live pool
 * implementations — plain, lending, metapool, crypto, and the newer `-ng` variants
 * — with different internal accounting, different fee handling, and even different
 * coin-index types. A local port would have to be right for all of them, and when
 * it was wrong it would be wrong *silently*. `get_dy` is the pool's own quote:
 * exact by construction, for every variant, forever.
 *
 * The cost is that Curve pools cannot be re-priced for free during optimal-size
 * search, so they take the same batched screen-then-ladder path as Uniswap V3.
 */

import { Interface } from 'ethers';
import { CURVE_POOL_INT128_ABI, CURVE_POOL_UINT_ABI } from '../abi';
import { multicall, type ChainContext } from '../provider';
import type { CurvePool } from './pools';
import type { DexVenue, TokenInfo } from '../../types';
import { createLogger } from '../../logger';

const log = createLogger('dex:curve');

const int128Iface = new Interface(CURVE_POOL_INT128_ABI);
const uintIface = new Interface(CURVE_POOL_UINT_ABI);

/** Curve reports fee with 1e10 precision: 1_000_000 == 0.01% == 1 bp. */
const CURVE_FEE_DENOMINATOR = 10n ** 10n;
const DEFAULT_CURVE_FEE_BPS = 4; // 0.04%, the long-standing 3pool default.

/** How many coins to probe when mapping a pool's assets. Covers every common pool. */
const MAX_COINS = 8;

function ifaceFor(int128Indices: boolean): Interface {
  return int128Indices ? int128Iface : uintIface;
}

/** Encode `get_dy` for whichever index type this pool declares. */
export function encodeCurveGetDy(
  pool: CurvePool,
  indexIn: number,
  indexOut: number,
  amountIn: bigint,
): string {
  return ifaceFor(pool.int128Indices).encodeFunctionData('get_dy', [
    indexIn,
    indexOut,
    amountIn,
  ]);
}

export function decodeCurveGetDy(pool: CurvePool, returnData: string): bigint | undefined {
  try {
    const decoded = ifaceFor(pool.int128Indices).decodeFunctionResult('get_dy', returnData);
    return BigInt(decoded[0] as bigint | string);
  } catch {
    return undefined;
  }
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Map each configured Curve pool's coin list, then emit one `CurvePool` per
 * tradeable pair of interest found inside it.
 *
 * Curve pools are multi-asset, so a single 3pool yields three pairs. Pools are
 * named explicitly in the venue config rather than enumerated from a registry:
 * Curve's registries disagree across deployments and include long-dead pools, so
 * discovery-by-registry produces confident-looking garbage.
 */
export async function discoverCurvePools(
  ctx: ChainContext,
  venue: DexVenue,
  tokens: TokenInfo[],
): Promise<CurvePool[]> {
  const addresses = venue.curvePools ?? [];
  if (addresses.length === 0) return [];

  const byAddress = new Map<string, TokenInfo>();
  for (const token of tokens) byAddress.set(token.address.toLowerCase(), token);

  // Read coins(0..MAX_COINS) for every pool in one batch. Out-of-range indices
  // revert, which is exactly how the coin count is discovered — allowFailure
  // turns that revert into a boundary marker rather than an error.
  const calls: Array<{ target: string; callData: string }> = [];
  for (const address of addresses) {
    for (let i = 0; i < MAX_COINS; i += 1) {
      calls.push({
        target: address,
        callData: uintIface.encodeFunctionData('coins', [i]),
      });
    }
  }

  const results = await multicall(ctx, calls, 40);

  const pools: CurvePool[] = [];
  const feeTargets: string[] = [];
  const emittedPerPool: number[] = [];

  for (let p = 0; p < addresses.length; p += 1) {
    const address = addresses[p];
    if (!address) continue;

    const coins: Array<{ token: TokenInfo; index: number }> = [];
    for (let i = 0; i < MAX_COINS; i += 1) {
      const result = results[p * MAX_COINS + i];
      if (!result?.success || result.returnData === '0x') break; // past the last coin
      let coin: string;
      try {
        coin = uintIface.decodeFunctionResult('coins', result.returnData)[0] as string;
      } catch {
        break;
      }
      const token = byAddress.get(coin.toLowerCase());
      if (token) coins.push({ token, index: i });
    }

    if (coins.length < 2) {
      log.debug('curve pool has fewer than two known coins, skipping', { pool: address });
      continue;
    }

    let emitted = 0;
    for (let a = 0; a < coins.length; a += 1) {
      for (let b = a + 1; b < coins.length; b += 1) {
        const first = coins[a];
        const second = coins[b];
        if (!first || !second) continue;
        pools.push({
          kind: 'curve',
          venueId: venue.id,
          venueLabel: venue.label,
          router: address, // Curve swaps go through the pool itself, not a router.
          pool: address,
          tokenA: first.token,
          tokenB: second.token,
          indexA: first.index,
          indexB: second.index,
          // Resolved below by probing both signatures.
          int128Indices: true,
          feeBps: DEFAULT_CURVE_FEE_BPS,
        });
        emitted += 1;
      }
    }

    if (emitted > 0) {
      feeTargets.push(address);
      emittedPerPool.push(emitted);
    }
  }

  if (pools.length === 0) return [];

  await resolveIndexType(ctx, pools);
  await applyFees(ctx, pools, feeTargets, emittedPerPool);

  log.debug('discovered pools', {
    venue: venue.id,
    chain: ctx.chain.name,
    pairs: pools.length,
    pools: addresses.length,
  });

  return pools;
}

/**
 * Determine whether each pool wants int128 or uint256 coin indices.
 *
 * Both encodings are tried with a tiny probe and whichever answers is recorded.
 * Guessing from the pool version would be fragile — the selector is what actually
 * decides, and asking costs one batched call at startup.
 */
async function resolveIndexType(ctx: ChainContext, pools: CurvePool[]): Promise<void> {
  const probes = pools.map((pool) => {
    const amount = 10n ** BigInt(pool.tokenA.decimals);
    return [
      {
        target: pool.pool,
        callData: int128Iface.encodeFunctionData('get_dy', [pool.indexA, pool.indexB, amount]),
      },
      {
        target: pool.pool,
        callData: uintIface.encodeFunctionData('get_dy', [pool.indexA, pool.indexB, amount]),
      },
    ];
  });

  const results = await multicall(ctx, probes.flat(), 40);

  for (let i = 0; i < pools.length; i += 1) {
    const pool = pools[i];
    if (!pool) continue;
    const asInt128 = results[i * 2];
    const asUint = results[i * 2 + 1];

    if (asInt128?.success && asInt128.returnData !== '0x') {
      pool.int128Indices = true;
    } else if (asUint?.success && asUint.returnData !== '0x') {
      pool.int128Indices = false;
    } else {
      // Neither answered. Leave the default; the pool will simply fail to quote
      // and be dropped from the working set rather than producing a wrong number.
      log.debug('curve pool did not answer either get_dy signature', {
        pool: pool.pool,
        pair: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
      });
    }
  }
}

/** Read each pool's live fee, falling back to the 3pool default. */
async function applyFees(
  ctx: ChainContext,
  pools: CurvePool[],
  targets: string[],
  emittedPerPool: number[],
): Promise<void> {
  if (targets.length === 0) return;

  const results = await multicall(
    ctx,
    targets.map((target) => ({
      target,
      callData: uintIface.encodeFunctionData('fee', []),
    })),
    60,
  );

  let cursor = 0;
  for (let t = 0; t < targets.length; t += 1) {
    const count = emittedPerPool[t] ?? 0;
    const result = results[t];

    let feeBps = DEFAULT_CURVE_FEE_BPS;
    if (result?.success && result.returnData !== '0x') {
      try {
        const raw = BigInt(uintIface.decodeFunctionResult('fee', result.returnData)[0] as bigint);
        // raw / 1e10 is a fraction; * 10_000 gives bps.
        const bps = Number((raw * 10_000n) / CURVE_FEE_DENOMINATOR);
        if (Number.isFinite(bps) && bps >= 0 && bps <= 1_000) feeBps = bps;
      } catch {
        // Keep the default.
      }
    }

    for (let i = 0; i < count; i += 1) {
      const pool = pools[cursor + i];
      if (pool) pool.feeBps = feeBps;
    }
    cursor += count;
  }
}

// ── quoting ──────────────────────────────────────────────────────────────────

export interface CurveQuoteRequest {
  pool: CurvePool;
  aToB: boolean;
  amountIn: bigint;
}

/**
 * Batch-quote Curve pools. Mirrors the Uniswap V3 quoter path so the scanner can
 * treat every on-chain-quoted venue identically.
 */
export async function quoteCurveBatch(
  ctx: ChainContext,
  requests: CurveQuoteRequest[],
): Promise<Array<bigint | undefined>> {
  if (requests.length === 0) return [];

  const calls = requests.map((request) => ({
    target: request.pool.pool,
    callData: encodeCurveGetDy(
      request.pool,
      request.aToB ? request.pool.indexA : request.pool.indexB,
      request.aToB ? request.pool.indexB : request.pool.indexA,
      request.amountIn,
    ),
  }));

  const results = await multicall(ctx, calls, 40);

  return requests.map((request, i) => {
    const result = results[i];
    if (!result?.success || result.returnData === '0x') return undefined;
    const out = decodeCurveGetDy(request.pool, result.returnData);
    return out !== undefined && out > 0n ? out : undefined;
  });
}

/** Spot price implied by the last probe quote, for the screening pass. */
export function curveSpotPrice(pool: CurvePool, aToB: boolean): number {
  if (
    pool.probeAmountIn === undefined ||
    pool.probeAmountOut === undefined ||
    pool.probeAmountIn <= 0n ||
    pool.probeAmountOut <= 0n ||
    pool.probeDirectionAToB !== aToB
  ) {
    return 0;
  }

  const inToken = aToB ? pool.tokenA : pool.tokenB;
  const outToken = aToB ? pool.tokenB : pool.tokenA;
  const inFloat = Number(pool.probeAmountIn) / 10 ** inToken.decimals;
  const outFloat = Number(pool.probeAmountOut) / 10 ** outToken.decimals;
  return inFloat > 0 ? outFloat / inFloat : 0;
}
