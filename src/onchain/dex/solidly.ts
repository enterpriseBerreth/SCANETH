/**
 * Solidly / Aerodrome / Velodrome adapter.
 *
 * Solidly forks run two curve shapes behind one interface:
 *
 *   volatile  x·y = k                    — identical to Uniswap V2
 *   stable    x³y + y³x = k              — far flatter near the peg
 *
 * The stable curve is the entire reason this venue is worth wiring in. It prices
 * correlated assets very differently from Uniswap V3's concentrated ticks, so the
 * two disagree structurally rather than occasionally, and that disagreement
 * regenerates as flow arrives instead of being arbitraged away permanently.
 *
 * The maths below is a deliberate line-by-line integer port of Aerodrome's
 * `Pool.sol`, not a reimplementation. That choice matters: an approximate stable
 * curve does not fail loudly, it returns a plausible-looking number that is
 * wrong, and the bot would book profits that never existed. `npm run verify:solidly`
 * checks this port against the pools' own `getAmountOut` on live state, which is
 * the only trustworthy oracle for it.
 *
 * Because the port is local, Solidly pools join the *fast* path: once reserves
 * are cached, the optimal-size search runs entirely in process with no RPC per
 * candidate size, exactly like Uniswap V2.
 */

import { Interface } from 'ethers';
import { SOLIDLY_FACTORY_ABI, SOLIDLY_POOL_ABI } from '../abi';
import { isZeroAddress, multicall, type ChainContext } from '../provider';
import type { SolidlyPool } from './pools';
import type { DexVenue, TokenInfo } from '../../types';
import { createLogger } from '../../logger';

const log = createLogger('dex:solidly');

const factoryIface = new Interface(SOLIDLY_FACTORY_ABI);
const poolIface = new Interface(SOLIDLY_POOL_ABI);

const WAD = 10n ** 18n;

/**
 * Aerodrome charges fees in hundredths of a percent via the factory, and pools
 * can be individually overridden. 5 = 0.05% is the usual stable default; this is
 * only a fallback for when the factory call fails.
 */
const DEFAULT_STABLE_FEE_BPS = 5;
const DEFAULT_VOLATILE_FEE_BPS = 30;

// ── stable curve ─────────────────────────────────────────────────────────────

/** `f(x0, y) = x0·y·(x0² + y²) / 1e54`, the stable invariant's y-branch. */
function f(x0: bigint, y: bigint): bigint {
  const a = (x0 * y) / WAD;
  const b = (x0 * x0) / WAD + (y * y) / WAD;
  return (a * b) / WAD;
}

/** `d(x0, y) = 3·x0·y²/1e36 + x0³/1e36`, i.e. ∂f/∂y. Newton's denominator. */
function d(x0: bigint, y: bigint): bigint {
  return (3n * x0 * ((y * y) / WAD)) / WAD + (((x0 * x0) / WAD) * x0) / WAD;
}

/**
 * Solve `f(x0, y) = xy` for y by Newton–Raphson.
 *
 * Mirrors Aerodrome's `_get_y` including its 255-iteration cap and its
 * within-1-wei convergence test. The iteration count is not a safety margin to be
 * tuned — matching it is what makes the local quote agree with the contract to
 * the wei, which is the whole point.
 */
function getY(x0: bigint, xy: bigint, yStart: bigint): bigint {
  let y = yStart;

  for (let i = 0; i < 255; i += 1) {
    const yPrev = y;
    const k = f(x0, y);
    const denominator = d(x0, y);

    // Guard the division the contract does not need to: on-chain a zero here
    // reverts the swap, but in a scanner a throw would kill the whole pass, so
    // an unquotable pool is reported as unquotable instead.
    if (denominator === 0n) return 0n;

    if (k < xy) {
      let dy = ((xy - k) * WAD) / denominator;
      if (dy === 0n) {
        // Aerodrome treats both of these as converged rather than looping.
        if (k === xy) return y;
        if (f(x0, y + 1n) > xy) return y + 1n;
        dy = 1n;
      }
      y += dy;
    } else {
      let dy = ((k - xy) * WAD) / denominator;
      if (dy === 0n) {
        if (k === xy || f(x0, y - 1n) < xy) return y;
        dy = 1n;
      }
      y -= dy;
    }

    // Converged to within a wei.
    if (y > yPrev ? y - yPrev <= 1n : yPrev - y <= 1n) return y;
  }

  return y;
}

/** The invariant `k` for the pool's current reserves. */
function invariant(
  reserve0: bigint,
  reserve1: bigint,
  scale0: bigint,
  scale1: bigint,
): bigint {
  const x = (reserve0 * WAD) / scale0;
  const y = (reserve1 * WAD) / scale1;
  const a = (x * y) / WAD;
  const b = (x * x) / WAD + (y * y) / WAD;
  return (a * b) / WAD;
}

/**
 * Output of a Solidly swap, matching `Pool.getAmountOut` exactly.
 *
 * `feeBps` is applied to the input first, as the contract does, before the curve
 * is evaluated — applying it to the output instead produces a subtly different
 * and slightly optimistic number.
 */
export function getAmountOutSolidly(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  scaleIn: bigint,
  scaleOut: bigint,
  feeBps: number,
  stable: boolean,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const afterFee = amountIn - (amountIn * BigInt(Math.round(feeBps))) / 10_000n;
  if (afterFee <= 0n) return 0n;

  if (!stable) {
    // Identical to Uniswap V2 once the fee has been taken off the input.
    return (afterFee * reserveOut) / (reserveIn + afterFee);
  }

  const xy = invariant(reserveIn, reserveOut, scaleIn, scaleOut);
  const normReserveIn = (reserveIn * WAD) / scaleIn;
  const normReserveOut = (reserveOut * WAD) / scaleOut;
  const normAmountIn = (afterFee * WAD) / scaleIn;

  const y = normReserveOut - getY(normAmountIn + normReserveIn, xy, normReserveOut);
  const out = (y * scaleOut) / WAD;

  // Cannot drain the pool.
  return out >= reserveOut ? 0n : out;
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Resolve pool addresses for the configured pairs.
 *
 * Every pair is probed in *both* stable and volatile variants, because a pair can
 * legitimately have both and they will hold different prices — which is itself a
 * tradeable disagreement, on the same venue.
 */
export async function discoverSolidlyPools(
  ctx: ChainContext,
  venue: DexVenue,
  pairs: Array<[TokenInfo, TokenInfo]>,
): Promise<SolidlyPool[]> {
  if (!venue.factory) {
    log.warn('venue has no factory configured, skipping', { venue: venue.id });
    return [];
  }

  type Candidate = { tokenA: TokenInfo; tokenB: TokenInfo; stable: boolean };
  const candidates: Candidate[] = [];
  for (const [tokenA, tokenB] of pairs) {
    candidates.push({ tokenA, tokenB, stable: true });
    candidates.push({ tokenA, tokenB, stable: false });
  }

  const lookups = candidates.map((c) => ({
    target: venue.factory as string,
    callData: factoryIface.encodeFunctionData('getPool', [
      c.tokenA.address,
      c.tokenB.address,
      c.stable,
    ]),
  }));

  const found = await multicall(ctx, lookups, 40);

  const resolved: Array<Candidate & { pool: string }> = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const result = found[i];
    if (!candidate || !result?.success || result.returnData === '0x') continue;

    let address: string;
    try {
      address = factoryIface.decodeFunctionResult('getPool', result.returnData)[0] as string;
    } catch {
      continue;
    }
    if (isZeroAddress(address)) continue;
    resolved.push({ ...candidate, pool: address });
  }

  if (resolved.length === 0) return [];

  // Read each pool's own fee rather than assuming the factory default. Aerodrome
  // governance sets these per pool, and a wrong fee is a systematic bias in every
  // quote from that pool — small per trade, decisive over a ledger.
  const feeCalls = resolved.map((r) => ({
    target: venue.factory as string,
    callData: factoryIface.encodeFunctionData('getFee', [r.pool, r.stable]),
  }));
  const fees = await multicall(ctx, feeCalls, 60);

  const pools: SolidlyPool[] = resolved.map((r, i) => {
    let feeBps = r.stable ? DEFAULT_STABLE_FEE_BPS : DEFAULT_VOLATILE_FEE_BPS;
    const result = fees[i];
    if (result?.success && result.returnData !== '0x') {
      try {
        // Aerodrome returns fee in hundredths of a percent, i.e. already bps.
        const raw = Number(factoryIface.decodeFunctionResult('getFee', result.returnData)[0]);
        if (Number.isFinite(raw) && raw >= 0 && raw <= 1_000) feeBps = raw;
      } catch {
        // Keep the default.
      }
    }

    return {
      kind: 'solidly' as const,
      venueId: venue.id,
      venueLabel: venue.label,
      router: venue.router,
      pool: r.pool,
      tokenA: r.tokenA,
      tokenB: r.tokenB,
      stable: r.stable,
      feeBps,
      reserveA: 0n,
      reserveB: 0n,
      scaleA: 10n ** BigInt(r.tokenA.decimals),
      scaleB: 10n ** BigInt(r.tokenB.decimals),
    };
  });

  log.debug('discovered pools', {
    venue: venue.id,
    chain: ctx.chain.name,
    stable: pools.filter((p) => p.stable).length,
    volatile: pools.filter((p) => !p.stable).length,
  });

  return pools;
}

/**
 * Refresh reserves in one batched call.
 *
 * Solidly's `getReserves` returns reserves ordered by `token0`, which is the
 * address-sorted pair, so orientation is derived locally rather than spending an
 * extra `token0()` call per pool.
 */
export async function refreshSolidlyReserves(
  ctx: ChainContext,
  pools: SolidlyPool[],
): Promise<SolidlyPool[]> {
  if (pools.length === 0) return [];

  const calls = pools.map((p) => ({
    target: p.pool,
    callData: poolIface.encodeFunctionData('getReserves', []),
  }));

  const results = await multicall(ctx, calls, 60);

  return pools.map((pool, i) => {
    const result = results[i];
    if (!result?.success || result.returnData === '0x') {
      return { ...pool, reserveA: 0n, reserveB: 0n };
    }

    try {
      const decoded = poolIface.decodeFunctionResult('getReserves', result.returnData);
      const reserve0 = BigInt(decoded[0] as bigint | string);
      const reserve1 = BigInt(decoded[1] as bigint | string);
      const aIsToken0 =
        pool.tokenA.address.toLowerCase() < pool.tokenB.address.toLowerCase();
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

/** Spot price of tokenB per tokenA, for the cheap screening pass. */
export function solidlySpotPrice(pool: SolidlyPool, aToB: boolean): number {
  if (pool.reserveA <= 0n || pool.reserveB <= 0n) return 0;

  // Quote a small probe rather than using the reserve ratio. On the stable curve
  // the reserve ratio is a poor proxy for the marginal price — that flatness is
  // precisely the property being exploited — so screening on it would rank pools
  // by the wrong number and discard the good ones.
  const probeIn = aToB ? pool.scaleA / 100n : pool.scaleB / 100n;
  const amountIn = probeIn > 0n ? probeIn : 1n;

  const out = getAmountOutSolidly(
    amountIn,
    aToB ? pool.reserveA : pool.reserveB,
    aToB ? pool.reserveB : pool.reserveA,
    aToB ? pool.scaleA : pool.scaleB,
    aToB ? pool.scaleB : pool.scaleA,
    pool.feeBps,
    pool.stable,
  );
  if (out <= 0n) return 0;

  const inScale = Number(aToB ? pool.scaleA : pool.scaleB);
  const outScale = Number(aToB ? pool.scaleB : pool.scaleA);
  const inFloat = Number(amountIn) / inScale;
  const outFloat = Number(out) / outScale;
  return inFloat > 0 ? outFloat / inFloat : 0;
}

/** Reserve depth in USD, for liquidity filtering. */
export function solidlyLiquidityUsd(
  pool: SolidlyPool,
  priceOf?: (token: TokenInfo) => number,
): number {
  const priceFor = (token: TokenInfo): number => {
    const live = priceOf?.(token) ?? 0;
    if (live > 0) return live;
    return token.stable ? 1 : (token.usdHint ?? 0);
  };

  const a = (Number(pool.reserveA) / Number(pool.scaleA)) * priceFor(pool.tokenA);
  const b = (Number(pool.reserveB) / Number(pool.scaleB)) * priceFor(pool.tokenB);
  return a + b;
}
