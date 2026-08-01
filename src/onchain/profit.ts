/**
 * Profit engine — the part that decides whether an "opportunity" is real.
 *
 * Every cost is accounted for explicitly:
 *   1. swap fee on every leg
 *   2. price impact / slippage (implicit in the constant-product maths)
 *   3. flash-loan premium
 *   4. gas, converted to USD
 *
 * A naive arbitrage bot compares spot prices, sees "0.4% spread!" and loses
 * money on every trade because 1–4 exceed the spread. The whole point of this
 * module is to never do that.
 *
 * All functions here are pure so they can be unit-checked without a network.
 */

import { formatUnits, parseUnits } from 'ethers';
import type { RouteLeg, TokenInfo } from '../types';

const BPS_DENOMINATOR = 10_000n;

// ── unit helpers ─────────────────────────────────────────────────────────────

/** bigint token amount -> float, tolerating values far beyond Number range. */
export function toFloat(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

/** float token amount -> bigint, clamped at zero. */
export function toBigInt(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  // toFixed keeps us clear of float artefacts like 0.1 -> 0.09999999999999999
  return parseUnits(amount.toFixed(Math.min(decimals, 18)), decimals);
}

// ── AMM maths ────────────────────────────────────────────────────────────────

/**
 * Uniswap V2 constant-product output.
 *
 *   amountInWithFee = amountIn * (10000 - feeBps)
 *   out = (amountInWithFee * reserveOut) / (reserveIn * 10000 + amountInWithFee)
 *
 * Integer arithmetic throughout, matching on-chain truncation.
 */
export function getAmountOutV2(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const feeMultiplier = BPS_DENOMINATOR - BigInt(feeBps);
  const amountInWithFee = amountIn * feeMultiplier;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS_DENOMINATOR + amountInWithFee;
  if (denominator === 0n) return 0n;

  const out = numerator / denominator;
  // Cannot drain the pool.
  return out >= reserveOut ? 0n : out;
}

/** Flash-loan premium owed on top of the borrowed principal. */
export function flashFee(amount: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return 0n;
  // Aave rounds the premium up.
  const fee = (amount * BigInt(feeBps)) / BPS_DENOMINATOR;
  return (amount * BigInt(feeBps)) % BPS_DENOMINATOR === 0n ? fee : fee + 1n;
}

/**
 * Walk a route locally using captured V2 reserves.
 *
 * Only valid when every leg is univ2 and no pool appears twice — which holds
 * for cross-venue cycles, since each leg is a different pool. V3 legs cannot be
 * repriced locally (tick maths needs pool state), so those cycles are sized via
 * an on-chain quote ladder instead. See `bestFromLadder`.
 */
export function simulateV2Cycle(legs: RouteLeg[], amountIn: bigint): bigint {
  let amount = amountIn;
  for (const leg of legs) {
    if (leg.reserveIn === undefined || leg.reserveOut === undefined) {
      throw new Error(`simulateV2Cycle: leg on ${leg.venueId} is missing reserves`);
    }
    amount = getAmountOutV2(amount, leg.reserveIn, leg.reserveOut, leg.feeBps);
    if (amount === 0n) return 0n;
  }
  return amount;
}

/** True when every leg can be priced locally. */
export function isLocallyPriceable(legs: RouteLeg[]): boolean {
  return legs.every(
    (l) => l.kind === 'univ2' && l.reserveIn !== undefined && l.reserveOut !== undefined,
  );
}

// ── optimal sizing ───────────────────────────────────────────────────────────

/**
 * Maximise a unimodal integer function by ternary search.
 *
 * Arbitrage profit as a function of trade size is unimodal: too small and fixed
 * costs dominate, too large and price impact eats the spread. Ternary search
 * finds the peak without derivatives, and unlike the V2-only closed form it
 * keeps working for mixed-venue routes.
 */
export function ternarySearchMax(
  f: (x: bigint) => bigint,
  lo: bigint,
  hi: bigint,
  maxIterations = 220,
): { x: bigint; value: bigint } {
  let a = lo;
  let b = hi;
  if (b < a) [a, b] = [b, a];

  let iterations = 0;
  while (b - a > 2n && iterations < maxIterations) {
    const third = (b - a) / 3n;
    if (third === 0n) break;
    const m1 = a + third;
    const m2 = b - third;
    if (f(m1) < f(m2)) a = m1;
    else b = m2;
    iterations += 1;
  }

  // Resolve the last few integers exactly.
  let bestX = a;
  let bestValue = f(a);
  for (let x = a + 1n; x <= b; x += 1n) {
    const value = f(x);
    if (value > bestValue) {
      bestValue = value;
      bestX = x;
    }
  }
  return { x: bestX, value: bestValue };
}

/**
 * Profit of a locally-priceable cycle, in base-token units.
 * Negative means the cycle loses money at that size.
 */
export function cycleProfit(legs: RouteLeg[], amountIn: bigint, flashFeeBps: number): bigint {
  const out = simulateV2Cycle(legs, amountIn);
  if (out === 0n) return -amountIn;
  return out - amountIn - flashFee(amountIn, flashFeeBps);
}

/** Find the trade size maximising profit for a locally-priceable cycle. */
export function optimalSize(
  legs: RouteLeg[],
  minAmountIn: bigint,
  maxAmountIn: bigint,
  flashFeeBps: number,
): { amountIn: bigint; amountOut: bigint; profit: bigint } {
  const objective = (x: bigint): bigint => cycleProfit(legs, x, flashFeeBps);
  const { x, value } = ternarySearchMax(objective, minAmountIn, maxAmountIn);
  return { amountIn: x, amountOut: simulateV2Cycle(legs, x), profit: value };
}

/**
 * Pick the best size from a set of pre-quoted samples.
 * Used for routes containing V3 legs, where sizes must be quoted on-chain.
 */
export function bestFromLadder(
  samples: Array<{ amountIn: bigint; amountOut: bigint }>,
  flashFeeBps: number,
): { amountIn: bigint; amountOut: bigint; profit: bigint } | undefined {
  let best: { amountIn: bigint; amountOut: bigint; profit: bigint } | undefined;
  for (const s of samples) {
    if (s.amountOut === 0n) continue;
    const profit = s.amountOut - s.amountIn - flashFee(s.amountIn, flashFeeBps);
    if (!best || profit > best.profit) {
      best = { amountIn: s.amountIn, amountOut: s.amountOut, profit };
    }
  }
  return best;
}

/**
 * Geometrically spaced trade sizes between two bounds.
 *
 * Geometric rather than linear because the profit curve varies over orders of
 * magnitude. Operates directly on raw base units so it is decimals-agnostic —
 * a 6-decimal USDC ladder and an 18-decimal WETH ladder both work.
 */
export function sizeLadder(minAmountIn: bigint, maxAmountIn: bigint, steps: number): bigint[] {
  if (steps <= 1 || maxAmountIn <= minAmountIn) return [maxAmountIn];

  const lo = Number(minAmountIn);
  const hi = Number(maxAmountIn);
  if (!(lo > 0) || !(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return [maxAmountIn];
  }

  const ratio = Math.pow(hi / lo, 1 / (steps - 1));
  const out: bigint[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < steps; i += 1) {
    const value = Math.floor(lo * Math.pow(ratio, i));
    if (!Number.isFinite(value) || value <= 0) continue;
    const asBigInt = BigInt(value);
    const key = asBigInt.toString();
    if (asBigInt > 0n && asBigInt <= maxAmountIn && !seen.has(key)) {
      out.push(asBigInt);
      seen.add(key);
    }
  }

  return out.length > 0 ? out : [maxAmountIn];
}

// ── costing ──────────────────────────────────────────────────────────────────

/** Gas cost of a transaction expressed in USD. */
export function gasCostUsd(gasUnits: bigint, gasPriceWei: bigint, nativeUsdPrice: number): number {
  const weiCost = gasUnits * gasPriceWei;
  return toFloat(weiCost, 18) * nativeUsdPrice;
}

// ── route gas modelling ─────────────────────────────────────────────────────
//
// A single flat gas constant applied to every route is one of the quieter ways
// an arbitrage bot loses money. A two-leg V2 cycle and a three-leg V3 cycle
// differ by roughly 2x, so one number is necessarily wrong for most routes:
// too high rejects trades that were genuinely profitable, too low accepts
// trades that were not. Neither error announces itself — they surface only as
// results that never match what the maths promised.
//
// These are conservative central estimates. In live mode the executor still
// replaces them with a real `estimateGas` before sending; this model exists so
// that *screening* decisions are made on something defensible.

/** Base transaction cost, paid regardless of route shape. */
const GAS_TX_OVERHEAD = 21_000n;
/** Aave V3 flashLoanSimple: borrow, callback, repay, plus aToken accounting. */
const GAS_FLASH_AAVE = 180_000n;
/** Balancer V2 is materially cheaper — no interest-bearing token bookkeeping. */
const GAS_FLASH_BALANCER = 110_000n;
/** Constant-product swap: transferFrom, swap, sync. */
const GAS_SWAP_V2 = 90_000n;
/**
 * Concentrated-liquidity swap. Genuinely variable: crossing initialised ticks
 * costs more, so a volatile pair in a thin fee tier can exceed this. Set at the
 * upper end of typical rather than at the average, because underestimating gas
 * is what turns a correctly-rejected loser into an accepted one.
 */
const GAS_SWAP_V3 = 130_000n;
/** Router approval per hop; the contract re-approves rather than tracking state. */
const GAS_APPROVE = 26_000n;
/** Applied last, to absorb tick-crossing and cold-storage variance. */
const GAS_SAFETY_BPS = 1_500n; // 15%

/**
 * Estimated gas to execute `legs` inside a flash loan.
 *
 * `balancer` should be true when the 0-premium Balancer path is used, which is
 * cheaper both in fee and in gas.
 */
export function estimateRouteGas(legs: RouteLeg[], balancer: boolean): bigint {
  let gas = GAS_TX_OVERHEAD + (balancer ? GAS_FLASH_BALANCER : GAS_FLASH_AAVE);

  for (const leg of legs) {
    gas += GAS_APPROVE;
    gas += leg.kind === 'univ3' ? GAS_SWAP_V3 : GAS_SWAP_V2;
  }

  return gas + (gas * GAS_SAFETY_BPS) / 10_000n;
}

/** Value a token amount in USD. */
export function valueUsd(amount: bigint, token: TokenInfo, tokenUsdPrice: number): number {
  return toFloat(amount, token.decimals) * tokenUsdPrice;
}

/**
 * Price impact of a V2 swap in basis points, versus the pool's spot price.
 * Reported for observability; the profit maths already accounts for it.
 */
export function priceImpactBps(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): number {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0;
  const actualOut = getAmountOutV2(amountIn, reserveIn, reserveOut, feeBps);
  if (actualOut === 0n) return 10_000;

  // Spot output ignoring impact, but still net of fee.
  const spotOut = (amountIn * reserveOut * (BPS_DENOMINATOR - BigInt(feeBps))) /
    (reserveIn * BPS_DENOMINATOR);
  if (spotOut === 0n) return 0;

  const shortfall = spotOut - actualOut;
  return Number((shortfall * BPS_DENOMINATOR) / spotOut);
}
