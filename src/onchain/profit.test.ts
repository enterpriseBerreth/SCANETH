/**
 * Profit-engine verification.
 *
 * Run with: npm run test:profit
 *
 * These are deliberately hand-checkable. If the AMM maths is wrong the bot will
 * confidently report profit that does not exist, so this file exists to prove
 * the numbers against arithmetic worked out independently.
 */

import assert from 'node:assert/strict';
import {
  bestFromLadder,
  cycleProfit,
  flashFee,
  getAmountOutV2,
  optimalSize,
  priceImpactBps,
  sizeLadder,
  toBigInt,
  toFloat,
} from './profit';
import type { RouteLeg, TokenInfo } from '../types';

const WETH: TokenInfo = { symbol: 'WETH', address: '0x' + '1'.repeat(40), decimals: 18, usdHint: 3000 };
const USDC: TokenInfo = { symbol: 'USDC', address: '0x' + '2'.repeat(40), decimals: 6, usdHint: 1, stable: true };

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function v2Leg(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  reserveIn: bigint,
  reserveOut: bigint,
  venueId: string,
): RouteLeg {
  return {
    venueId,
    kind: 'univ2',
    router: '0x' + '3'.repeat(40),
    tokenIn,
    tokenOut,
    feeTier: 0,
    feeBps: 30,
    reserveIn,
    reserveOut,
  };
}

console.log('\nARBO profit engine verification\n');

// ── 1. getAmountOutV2 against an independently computed value ────────────────
//
// amountIn        = 1e18            (1 WETH)
// reserveIn       = 100e18          (100 WETH)
// reserveOut      = 300_000e6       (300,000 USDC -> spot 3000 USDC/WETH)
// feeBps          = 30
//
// amountInWithFee = 1e18 * 9970                      = 9.970e21
// numerator       = 9.970e21 * 3.0e11                = 2.9910e33
// denominator     = 100e18 * 10000 + 9.970e21        = 1.00997e24
// out             = 2.9910e33 / 1.00997e24           = 2.961474e9
//                 = 2961.474 USDC
//
// Sanity: 3000 spot, minus 0.3% fee (~9) minus ~1% impact (~29.5) -> ~2961.
check('getAmountOutV2 matches hand-computed Uniswap V2 output', () => {
  const out = getAmountOutV2(toBigInt(1, 18), toBigInt(100, 18), toBigInt(300_000, 6), 30);
  const asUsdc = toFloat(out, 6);
  assert.ok(
    asUsdc > 2961.4 && asUsdc < 2961.5,
    `expected ~2961.474 USDC, got ${asUsdc}`,
  );
});

check('getAmountOutV2 is zero for non-positive or empty inputs', () => {
  assert.equal(getAmountOutV2(0n, 100n, 100n, 30), 0n);
  assert.equal(getAmountOutV2(100n, 0n, 100n, 30), 0n);
  assert.equal(getAmountOutV2(100n, 100n, 0n, 30), 0n);
});

check('getAmountOutV2 never drains the pool', () => {
  // Absurdly large input against a tiny pool.
  const out = getAmountOutV2(toBigInt(1_000_000, 18), 1000n, 1000n, 30);
  assert.ok(out < 1000n, `output ${out} must stay below reserveOut`);
});

check('zero fee yields strictly more output than 30 bps fee', () => {
  const args = [toBigInt(1, 18), toBigInt(100, 18), toBigInt(300_000, 6)] as const;
  assert.ok(getAmountOutV2(args[0], args[1], args[2], 0) > getAmountOutV2(args[0], args[1], args[2], 30));
});

// ── 2. flash fee ────────────────────────────────────────────────────────────
// Aave V3 premium is 5 bps. 1,000,000 USDC -> 500 USDC.
check('flashFee computes Aave 5 bps premium exactly', () => {
  assert.equal(flashFee(toBigInt(1_000_000, 6), 5), toBigInt(500, 6));
});

check('flashFee is zero for Balancer (0 bps)', () => {
  assert.equal(flashFee(toBigInt(1_000_000, 6), 0), 0n);
});

check('flashFee rounds up, never in our favour', () => {
  // 1 wei * 5bps = 0.0005 -> must round to 1, not 0.
  assert.equal(flashFee(1n, 5), 1n);
});

// ── 3. A genuinely profitable two-venue cycle ───────────────────────────────
//
// Pool A: 100 WETH / 300,000 USDC -> WETH cheap at 3000
// Pool B: 100 WETH / 330,000 USDC -> WETH dear  at 3300
// Cycle : borrow USDC -> buy WETH on A -> sell WETH on B -> repay USDC
//
// A ~10% dislocation is far larger than reality, chosen so the optimum sits
// well inside the search bounds and the assertions are unambiguous.
const cheapPoolLeg = v2Leg(USDC, WETH, toBigInt(300_000, 6), toBigInt(100, 18), 'venue-a');
const dearPoolLeg = v2Leg(WETH, USDC, toBigInt(100, 18), toBigInt(330_000, 6), 'venue-b');
const profitableCycle = [cheapPoolLeg, dearPoolLeg];

check('profitable cycle is detected as profitable at its optimum', () => {
  const result = optimalSize(profitableCycle, toBigInt(100, 6), toBigInt(200_000, 6), 5);
  assert.ok(result.profit > 0n, `expected positive profit, got ${result.profit}`);
  assert.ok(result.amountIn > 0n, 'optimal size must be positive');
});

check('optimal size beats both half and double that size', () => {
  const { amountIn, profit } = optimalSize(profitableCycle, toBigInt(100, 6), toBigInt(200_000, 6), 5);
  const half = cycleProfit(profitableCycle, amountIn / 2n, 5);
  const double = cycleProfit(profitableCycle, amountIn * 2n, 5);
  assert.ok(profit >= half, `optimum ${profit} should beat half-size ${half}`);
  assert.ok(profit >= double, `optimum ${profit} should beat double-size ${double}`);
});

check('optimal size respects the configured upper bound', () => {
  const cap = toBigInt(5_000, 6);
  const { amountIn } = optimalSize(profitableCycle, toBigInt(100, 6), cap, 5);
  assert.ok(amountIn <= cap, `size ${amountIn} exceeded cap ${cap}`);
});

check('oversized trade destroys the profit (price impact dominates)', () => {
  // Borrowing 250k USDC against a 300k pool must be badly unprofitable.
  const profit = cycleProfit(profitableCycle, toBigInt(250_000, 6), 5);
  assert.ok(profit < 0n, `expected loss at absurd size, got ${profit}`);
});

// ── 4. No-arbitrage control ─────────────────────────────────────────────────
// Two identical pools cannot be profitable: you pay two swap fees for nothing.
check('identical pools yield no profit at any size', () => {
  const legA = v2Leg(USDC, WETH, toBigInt(300_000, 6), toBigInt(100, 18), 'venue-a');
  const legB = v2Leg(WETH, USDC, toBigInt(100, 18), toBigInt(300_000, 6), 'venue-b');
  const result = optimalSize([legA, legB], toBigInt(100, 6), toBigInt(200_000, 6), 5);
  assert.ok(result.profit <= 0n, `identical pools must not be profitable, got ${result.profit}`);
});

check('a spread smaller than fees is correctly rejected', () => {
  // 0.2% dislocation against 0.6% round-trip fees plus flash premium.
  const legA = v2Leg(USDC, WETH, toBigInt(300_000, 6), toBigInt(100, 18), 'venue-a');
  const legB = v2Leg(WETH, USDC, toBigInt(100, 18), toBigInt(300_600, 6), 'venue-b');
  const result = optimalSize([legA, legB], toBigInt(100, 6), toBigInt(200_000, 6), 5);
  assert.ok(result.profit <= 0n, `sub-fee spread must be rejected, got ${result.profit}`);
});

// ── 5. Ladder selection (used for V3 routes) ────────────────────────────────
check('bestFromLadder picks the highest-profit sample', () => {
  const best = bestFromLadder(
    [
      { amountIn: toBigInt(1_000, 6), amountOut: toBigInt(1_002, 6) }, // +2
      { amountIn: toBigInt(5_000, 6), amountOut: toBigInt(5_020, 6) }, // +20
      { amountIn: toBigInt(20_000, 6), amountOut: toBigInt(19_900, 6) }, // -100
    ],
    0,
  );
  assert.ok(best, 'expected a winning sample');
  assert.equal(best.amountIn, toBigInt(5_000, 6));
});

check('bestFromLadder ignores failed quotes', () => {
  const best = bestFromLadder(
    [
      { amountIn: toBigInt(1_000, 6), amountOut: 0n },
      { amountIn: toBigInt(2_000, 6), amountOut: toBigInt(2_005, 6) },
    ],
    0,
  );
  assert.ok(best);
  assert.equal(best.amountIn, toBigInt(2_000, 6));
});

check('sizeLadder is ascending and bounded', () => {
  const ladder = sizeLadder(toBigInt(1, 18), toBigInt(100, 18), 8);
  assert.ok(ladder.length > 1, 'ladder should contain multiple steps');
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i]! > ladder[i - 1]!, 'ladder must strictly ascend');
  }
  assert.ok(ladder[ladder.length - 1]! <= toBigInt(100, 18) + 1n, 'ladder must respect the cap');
});

// Regression: the ladder must work on 6-decimal tokens, not just 18-decimal
// ones. An earlier version hardcoded 18 decimals and produced sizes that were
// twelve orders of magnitude too large for USDC.
check('sizeLadder respects 6-decimal token bounds', () => {
  const min = toBigInt(200, 6);
  const max = toBigInt(25_000, 6);
  const ladder = sizeLadder(min, max, 8);
  assert.ok(ladder.length > 1, 'expected multiple steps');
  for (const size of ladder) {
    assert.ok(size >= min / 2n, `size ${size} is implausibly small for a $200 floor`);
    assert.ok(size <= max, `size ${size} exceeded the $25,000 cap ${max}`);
  }
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok(ladder[i]! > ladder[i - 1]!, 'ladder must strictly ascend');
  }
});

// ── 6. Price impact reporting ───────────────────────────────────────────────
check('price impact grows with trade size', () => {
  const rIn = toBigInt(100, 18);
  const rOut = toBigInt(300_000, 6);
  const small = priceImpactBps(toBigInt(0.01, 18), rIn, rOut, 30);
  const large = priceImpactBps(toBigInt(10, 18), rIn, rOut, 30);
  assert.ok(large > small, `impact should grow: small=${small} large=${large}`);
  assert.ok(small < 50, `1 bp-scale trade should have small impact, got ${small}`);
});

// ── 7. Unit conversion round-trip ───────────────────────────────────────────
check('toBigInt / toFloat round-trip cleanly', () => {
  assert.equal(toFloat(toBigInt(1234.5678, 6), 6), 1234.5678);
  assert.equal(toFloat(toBigInt(0.000001, 18), 18), 0.000001);
});

console.log(
  `\n${process.exitCode === 1 ? 'FAILED' : 'OK'} — ${passed} check(s) passed\n`,
);
