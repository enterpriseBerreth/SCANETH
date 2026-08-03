/**
 * Paper-ledger verification.
 *
 * Run with: npm run test:paper
 *
 * The point of paper trading is to decide whether to risk real money, so the
 * accounting has to be right and it has to be *pessimistic in the right places*.
 * These checks pin down the parts that would otherwise quietly flatter the
 * results: that a decayed edge is booked as a real loss rather than skipped, that
 * gas is charged even when nothing fills, and that reloading the ledger from disk
 * reproduces the same totals.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaperLedger, describeTokenPath } from './paper';
import { rebindReserves } from './onchain/scanner';
import type { PoolSet } from './onchain/dex';
import type { V2Pool } from './onchain/dex/pools';
import type { ArbOpportunity, RouteLeg, TokenInfo } from './types';

const WETH: TokenInfo = { symbol: 'WETH', address: `0x${'1'.repeat(40)}`, decimals: 18, usdHint: 1900 };
const USDC: TokenInfo = { symbol: 'USDC', address: `0x${'2'.repeat(40)}`, decimals: 6, usdHint: 1, stable: true };

const POOL_A = `0x${'a'.repeat(40)}`;
const POOL_B = `0x${'b'.repeat(40)}`;

function v2Pool(
  address: string,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
  reserveA: bigint,
  reserveB: bigint,
): V2Pool {
  return {
    kind: 'univ2',
    venueId: 'uniswap-v2',
    venueLabel: 'Uniswap V2',
    router: `0x${'3'.repeat(40)}`,
    pool: address,
    tokenA,
    tokenB,
    reserveA,
    reserveB,
    feeBps: 30,
  };
}

function poolSet(v2: V2Pool[]): PoolSet {
  return { v2, v3: [], solidly: [], curve: [] };
}

function v2LegWithPool(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  pool: string,
  reserveIn: bigint,
  reserveOut: bigint,
): RouteLeg {
  return {
    venueId: 'uniswap-v2',
    kind: 'univ2',
    router: `0x${'3'.repeat(40)}`,
    tokenIn,
    tokenOut,
    feeTier: 0,
    feeBps: 30,
    pool,
    reserveIn,
    reserveOut,
  };
}

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

function leg(tokenIn: TokenInfo, tokenOut: TokenInfo, venueId: string): RouteLeg {
  return {
    venueId,
    kind: 'univ2',
    router: `0x${'3'.repeat(40)}`,
    tokenIn,
    tokenOut,
    feeTier: 0,
    feeBps: 30,
    pool: `0x${'4'.repeat(40)}`,
    reserveIn: 1_000_000n,
    reserveOut: 1_000_000n,
  };
}

function opportunity(overrides: Partial<ArbOpportunity> = {}): ArbOpportunity {
  return {
    id: 'test-1',
    chain: 'base',
    kind: 'cross-venue',
    baseToken: USDC,
    legs: [leg(USDC, WETH, 'uniswap-v2'), leg(WETH, USDC, 'uniswap-v3')],
    amountIn: 1_000_000_000n,
    amountOut: 1_010_000_000n,
    notionalUsd: 1_000,
    grossProfitUsd: 10,
    netProfitUsd: 8,
    gasCostUsd: 2,
    flashFeeUsd: 0,
    priceImpactBps: 12,
    discoveredAt: Date.now(),
    ...overrides,
  } as ArbOpportunity;
}

/** Every test account opens with this, so capital assertions read plainly. */
const START_CAPITAL = 1_000;

async function withLedger(
  minProfitUsd: number,
  fn: (ledger: PaperLedger, path: string) => Promise<void>,
  startingCapitalUsd = START_CAPITAL,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'arbo-paper-'));
  const path = join(dir, 'ledger.jsonl');
  try {
    await fn(new PaperLedger(path, minProfitUsd, startingCapitalUsd), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log('\nPaper ledger checks\n');

  await check('a surviving edge is booked as a fill, net of gas', async () => {
    await withLedger(5, async (ledger) => {
      assert.ok(ledger.open(opportunity(), 'USDC->WETH->USDC', 0));
      const [entry] = ledger.due('base');
      assert.ok(entry, 'candidate should be due with zero delay');

      const trade = await ledger.settle(entry, {
        actualGrossUsd: 9,
        gasCostUsd: 2,
        quoted: true,
      });

      assert.equal(trade.outcome, 'filled');
      assert.equal(trade.actualNetUsd, 7, 'net must be gross minus gas');
      assert.equal(trade.wouldExecuteLive, true, '7 clears a 5 dollar floor');
      assert.equal(ledger.stats().netUsd, 7);
      assert.equal(ledger.stats().filled, 1);
    });
  });

  await check('a decayed edge reverts on-chain and costs gas only', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      // Edge shrank to less than gas between detection and settlement.
      const trade = await ledger.settle(entry, {
        actualGrossUsd: 0.5,
        gasCostUsd: 2,
        quoted: true,
      });

      // `ArboFlashArb` asserts `balance >= owed + minProfit` before repaying, so
      // a decayed route unwinds entirely. Gas is burned; the shortfall is not.
      assert.equal(trade.outcome, 'reverted');
      assert.equal(trade.actualNetUsd, -2, 'a reverted trade pays gas and nothing else');
      assert.equal(trade.wouldExecuteLive, false);
      assert.equal(ledger.stats().netUsd, -2);
      assert.equal(ledger.stats().reverted, 1);
      assert.equal(ledger.stats().filled, 0);
    });
  });

  await check('a candidate below the profit floor is never sent and costs nothing', async () => {
    await withLedger(5, async (ledger) => {
      // Expected net of $1 against a $5 floor: live, this transaction is never
      // broadcast, so it must not move the balance by so much as gas.
      ledger.open(opportunity({ netProfitUsd: 1, grossProfitUsd: 3 }), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      const trade = await ledger.settle(entry, {
        actualGrossUsd: 0.2,
        gasCostUsd: 2,
        quoted: true,
      });

      assert.equal(trade.outcome, 'skipped');
      assert.equal(trade.actualNetUsd, 0, 'an unsent trade has no P&L');
      assert.equal(trade.gasCostUsd, 0, 'an unsent trade burns no gas');
      assert.equal(trade.capitalAfterUsd, trade.capitalBeforeUsd);
      assert.equal(ledger.stats().netUsd, 0);
      assert.equal(ledger.stats().skipped, 1);
      assert.equal(ledger.stats().capitalUsd, START_CAPITAL);
    });
  });

  await check('a dead route costs exactly the gas', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      const trade = await ledger.settle(entry, {
        actualGrossUsd: 0,
        gasCostUsd: 3,
        quoted: false,
      });

      assert.equal(trade.outcome, 'dead');
      assert.equal(trade.actualGrossUsd, 0);
      assert.equal(trade.actualNetUsd, -3);
      assert.equal(ledger.stats().dead, 1);
    });
  });

  await check('expected profit never leaks into realised profit', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity({ netProfitUsd: 500, grossProfitUsd: 502 }), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      const trade = await ledger.settle(entry, {
        actualGrossUsd: 1,
        gasCostUsd: 2,
        quoted: true,
      });

      assert.equal(trade.expectedNetUsd, 500, 'prediction is retained for comparison');
      assert.equal(trade.actualNetUsd, -2, 'the revert costs gas, never the decayed gross');
      assert.equal(ledger.stats().netUsd, -2);
    });
  });

  await check('decay is measured in bps of notional', async () => {
    await withLedger(5, async (ledger) => {
      // Expected $10 gross on $1000 notional; realised $4. Lost $6 = 60 bps.
      ledger.open(opportunity({ grossProfitUsd: 10, notionalUsd: 1_000 }), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      const trade = await ledger.settle(entry, {
        actualGrossUsd: 4,
        gasCostUsd: 1,
        quoted: true,
      });

      assert.equal(trade.decayBps, 60);
      assert.equal(ledger.stats().avgDecayBps, 60);
    });
  });

  await check('the live-execution floor is applied to realised, not expected, profit', async () => {
    await withLedger(10, async (ledger) => {
      ledger.open(opportunity({ netProfitUsd: 50 }), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      // Predicted well above the floor, realised below it.
      const trade = await ledger.settle(entry, {
        actualGrossUsd: 9,
        gasCostUsd: 2,
        quoted: true,
      });

      assert.equal(trade.outcome, 'reverted', '9 gross cannot clear a 10 dollar guard');
      assert.equal(trade.actualNetUsd, -2, 'the on-chain guard reverts it, leaving gas');
      assert.equal(trade.wouldExecuteLive, false, 'a reverted trade is not a live win');
      assert.equal(ledger.stats().liveEligible, 0);
    });
  });

  await check('a repeated route does not inflate the trade count', async () => {
    await withLedger(5, async (ledger) => {
      const first = ledger.open(opportunity(), 'same-route', 60_000);
      const second = ledger.open(opportunity(), 'same-route', 60_000);
      assert.equal(first, true);
      assert.equal(second, false, 'the same live route must not queue twice');
      assert.equal(ledger.pendingCount, 1);
    });
  });

  await check('a candidate is not due before its delay elapses', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 10_000);
      assert.equal(ledger.due('base').length, 0, 'must wait out the settle delay');
      assert.equal(ledger.due('base', Date.now() + 11_000).length, 1);
    });
  });

  await check('settling removes the candidate from the pending set', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);
      await ledger.settle(entry, { actualGrossUsd: 1, gasCostUsd: 0.5, quoted: true });
      assert.equal(ledger.pendingCount, 0);
      assert.equal(ledger.due('base').length, 0);
    });
  });

  await check('totals survive a restart', async () => {
    await withLedger(5, async (ledger, path) => {
      for (const gross of [9, 0.5, 20]) {
        ledger.open(opportunity({ id: `t-${gross}` }), `route-${gross}`, 0);
        const due = ledger.due('base');
        const entry = due[due.length - 1];
        assert.ok(entry);
        await ledger.settle(entry, { actualGrossUsd: gross, gasCostUsd: 2, quoted: true });
      }

      const before = ledger.stats();
      assert.equal(before.trades, 3);
      // 9 fills (9-2=7), 0.5 reverts (gas only, -2), 20 fills (20-2=18).
      assert.equal(before.netUsd, 23);

      const reloaded = new PaperLedger(path, 5, START_CAPITAL);
      await reloaded.load();
      const after = reloaded.stats();

      assert.equal(after.trades, before.trades, 'trade count must survive reload');
      assert.equal(after.netUsd, before.netUsd, 'net P&L must survive reload');
      assert.equal(after.filled, before.filled);
      assert.equal(after.reverted, before.reverted);
      assert.equal(after.gasUsd, before.gasUsd);
    });
  });

  await check('trades from the old accounting model are not replayed', async () => {
    await withLedger(5, async (ledger, path) => {
      // A v1 row: the old model booked the full negative gross on a decayed
      // route, a loss the flash-loan guard makes impossible. Replaying it would
      // carry a fictional -$40 drawdown forward forever.
      const legacy = {
        kind: 'trade',
        id: 'v1',
        chain: 'base',
        route: 'old',
        baseSymbol: 'USDC',
        tokenPath: ['USDC', 'WETH', 'USDC'],
        notionalUsd: 1_000,
        detectedAt: Date.now(),
        expectedGrossUsd: 10,
        expectedNetUsd: 8,
        settledAt: Date.now(),
        settleDelayMs: 0,
        gasCostUsd: 2,
        actualGrossUsd: -38,
        actualNetUsd: -40,
        decayBps: 480,
        outcome: 'decayed',
        wouldExecuteLive: false,
        capitalBeforeUsd: 1_000,
        capitalAfterUsd: 960,
        pnlPct: -4,
      };
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, `${JSON.stringify(legacy)}\n`, 'utf8');

      // ...followed by one honest v2 trade.
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);
      await ledger.settle(entry, { actualGrossUsd: 9, gasCostUsd: 2, quoted: true });

      const reloaded = new PaperLedger(path, 5, START_CAPITAL);
      await reloaded.load();

      assert.equal(reloaded.stats().trades, 1, 'only the v2 trade counts');
      assert.equal(reloaded.stats().netUsd, 7, 'the v1 loss must not be replayed');
      assert.equal(reloaded.stats().capitalUsd, START_CAPITAL + 7);
    });
  });

  await check('a truncated final line does not corrupt the reload', async () => {
    await withLedger(5, async (ledger, path) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);
      await ledger.settle(entry, { actualGrossUsd: 9, gasCostUsd: 2, quoted: true });

      // Simulate the process dying mid-append.
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, '{"kind":"trade","id":"trunc', 'utf8');

      const reloaded = new PaperLedger(path, 5, START_CAPITAL);
      await reloaded.load();
      assert.equal(reloaded.stats().trades, 1, 'the intact record must still load');
      assert.equal(reloaded.stats().netUsd, 7);
    });
  });

  await check('market samples are recorded but never counted as trades', async () => {
    await withLedger(5, async (ledger, path) => {
      ledger.noteScan('base', -0.42, 105.4, 0);
      ledger.noteScan('base', -0.11, 98.2, 0);
      await ledger.flushMarketSamples();

      const raw = await readFile(path, 'utf8');
      const lines = raw.trim().split('\n');
      assert.equal(lines.length, 1, 'the window should collapse to one sample');

      const sample = JSON.parse(lines[0] ?? '{}');
      assert.equal(sample.kind, 'market');
      assert.equal(sample.scans, 2, 'both scans fold into the window');
      assert.equal(sample.bestNetUsd, -0.11, 'the best of the window is kept');
      assert.equal(sample.bestEdgeBps, 105.4);

      assert.equal(ledger.stats().trades, 0, 'samples must not appear as trades');

      const reloaded = new PaperLedger(path, 5, START_CAPITAL);
      await reloaded.load();
      assert.equal(reloaded.stats().trades, 0);
    });
  });

  await check('an unwritable ledger degrades instead of throwing', async () => {
    // A directory path can never be opened for append.
    const dir = await mkdtemp(join(tmpdir(), 'arbo-paper-ro-'));
    try {
      const ledger = new PaperLedger(dir, 5, START_CAPITAL);
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);

      const trade = await ledger.settle(entry, {
        actualGrossUsd: 9,
        gasCostUsd: 2,
        quoted: true,
      });

      assert.equal(trade.actualNetUsd, 7, 'accounting still works in memory');
      assert.equal(ledger.isWritable, false, 'durability loss must be visible');
      assert.equal(ledger.stats().netUsd, 7);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ── capital account ───────────────────────────────────────────────────────
  //
  // The balance is what makes the result legible. A sum of wins says nothing;
  // a balance that started at $1,000 and either grew or shrank says everything.
  // These checks pin that the account behaves like a real one: it debits losses,
  // compounds, reports percentages against the balance at risk, and survives a
  // restart on exactly the number that was written.

  console.log('\nCapital account\n');

  await check('the account opens at the configured starting balance', async () => {
    await withLedger(5, async (ledger) => {
      assert.equal(ledger.capital, START_CAPITAL);
      assert.equal(ledger.stats().capitalUsd, START_CAPITAL);
      assert.equal(ledger.stats().startingCapitalUsd, START_CAPITAL);
      assert.equal(ledger.stats().returnPct, 0);
      assert.equal(ledger.solvent, true);
    });
  });

  await check('a win credits the balance and a loss debits it', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity({ id: 'w' }), 'win', 0);
      let due = ledger.due('base');
      const win = due[due.length - 1];
      assert.ok(win);
      const winTrade = await ledger.settle(win, {
        actualGrossUsd: 9,
        gasCostUsd: 2,
        quoted: true,
      });

      assert.equal(winTrade.capitalBeforeUsd, 1_000);
      assert.equal(winTrade.capitalAfterUsd, 1_007, 'net +7 must land in the balance');

      ledger.open(opportunity({ id: 'l' }), 'loss', 0);
      due = ledger.due('base');
      const loss = due[due.length - 1];
      assert.ok(loss);
      const lossTrade = await ledger.settle(loss, {
        actualGrossUsd: 0,
        gasCostUsd: 3,
        quoted: false,
      });

      // Compounding: the second trade opens where the first closed.
      assert.equal(lossTrade.capitalBeforeUsd, 1_007, 'the balance must carry forward');
      assert.equal(lossTrade.capitalAfterUsd, 1_004, 'gas on a dead route is a real debit');
      assert.equal(ledger.capital, 1_004);
    });
  });

  await check('pnl percent is measured against capital before the trade', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);
      const trade = await ledger.settle(entry, {
        actualGrossUsd: 52,
        gasCostUsd: 2,
        quoted: true,
      });

      // net = 50 on a 1,000 balance = 5%.
      assert.equal(trade.actualNetUsd, 50);
      assert.equal(trade.pnlPct, 5);
    });
  });

  await check('a loss produces a negative pnl percent', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);
      const trade = await ledger.settle(entry, {
        actualGrossUsd: 0,
        gasCostUsd: 10,
        quoted: true,
      });

      assert.equal(trade.actualNetUsd, -10);
      assert.equal(trade.pnlPct, -1, 'a $10 loss on $1,000 is -1%');
      assert.equal(trade.outcome, 'reverted');
    });
  });

  await check('total return tracks the balance, not the win count', async () => {
    await withLedger(5, async (ledger) => {
      for (const [id, gross, gas] of [
        ['a', 30, 2],
        ['b', 0, 5],
        ['c', 27, 2],
      ] as const) {
        ledger.open(opportunity({ id }), `route-${id}`, 0);
        const due = ledger.due('base');
        const entry = due[due.length - 1];
        assert.ok(entry);
        await ledger.settle(entry, { actualGrossUsd: gross, gasCostUsd: gas, quoted: true });
      }

      // 28 - 5 + 25 = 48 on 1,000 = 4.8%.
      const stats = ledger.stats();
      assert.equal(stats.netUsd, 48);
      assert.equal(stats.capitalUsd, 1_048);
      assert.equal(stats.returnPct, 4.8);
    });
  });

  await check('the balance survives a restart exactly', async () => {
    await withLedger(5, async (ledger, path) => {
      for (const [id, gross] of [
        ['a', 9],
        ['b', 0.5],
        ['c', 20],
      ] as const) {
        ledger.open(opportunity({ id }), `route-${id}`, 0);
        const due = ledger.due('base');
        const entry = due[due.length - 1];
        assert.ok(entry);
        await ledger.settle(entry, { actualGrossUsd: gross, gasCostUsd: 2, quoted: true });
      }

      const before = ledger.stats();
      const reloaded = new PaperLedger(path, 5, START_CAPITAL);
      await reloaded.load();

      assert.equal(reloaded.capital, before.capitalUsd, 'balance must reload identically');
      assert.equal(reloaded.stats().returnPct, before.returnPct);
      assert.equal(reloaded.stats().capitalUsd, 1_023);
    });
  });

  await check('an exhausted account reports insolvency', async () => {
    // A $20 account cannot absorb a $25 loss.
    await withLedger(
      5,
      async (ledger) => {
        ledger.open(opportunity(), 'r', 0);
        const [entry] = ledger.due('base');
        assert.ok(entry);
        const trade = await ledger.settle(entry, {
          actualGrossUsd: 0,
          gasCostUsd: 25,
          quoted: false,
        });

        assert.equal(trade.capitalAfterUsd, -5);
        assert.equal(ledger.solvent, false, 'a negative balance cannot pay gas');
      },
      20,
    );
  });

  await check('every trade carries the token path for alerting', async () => {
    await withLedger(5, async (ledger) => {
      ledger.open(opportunity(), 'r', 0);
      const [entry] = ledger.due('base');
      assert.ok(entry);
      const trade = await ledger.settle(entry, {
        actualGrossUsd: 9,
        gasCostUsd: 2,
        quoted: true,
      });

      // The fixture route is USDC -> WETH -> USDC.
      assert.equal(trade.tokenPath, 'USDC -> WETH -> USDC');
    });
  });

  await check('an empty leg list still yields a usable token label', () => {
    assert.equal(describeTokenPath([], 'WETH'), 'WETH');
  });

  // ── settlement primitive ──────────────────────────────────────────────────
  //
  // Settlement re-quotes against fresh state. If reserves were not rebound the
  // re-quote would reproduce the detection-time price exactly, reporting zero
  // decay and a 100% fill rate — the precise failure paper trading exists to
  // avoid. These checks cover that substitution without needing an RPC.

  console.log('\nSettlement reserve rebinding\n');

  await check('stale reserves are replaced with current ones', async () => {
    const stale = v2LegWithPool(USDC, WETH, POOL_A, 1_000n, 2_000n);
    const pools = poolSet([
      v2Pool(POOL_A, USDC, WETH, 5_000n, 9_000n),
    ]);

    const rebound = rebindReserves(pools, [stale]);
    assert.ok(rebound, 'route should still be tradeable');
    assert.equal(rebound[0]?.reserveIn, 5_000n, 'reserveIn must come from the live pool');
    assert.equal(rebound[0]?.reserveOut, 9_000n, 'reserveOut must come from the live pool');
  });

  await check('reserve orientation follows the leg direction', async () => {
    // Same pool, traded the other way: in/out must swap.
    const reversed = v2LegWithPool(WETH, USDC, POOL_A, 0n, 0n);
    const pools = poolSet([v2Pool(POOL_A, USDC, WETH, 5_000n, 9_000n)]);

    const rebound = rebindReserves(pools, [reversed]);
    assert.ok(rebound);
    assert.equal(rebound[0]?.reserveIn, 9_000n, 'WETH side is the input here');
    assert.equal(rebound[0]?.reserveOut, 5_000n);
  });

  await check('a pool that left the working set makes the route dead', async () => {
    const leg = v2LegWithPool(USDC, WETH, POOL_A, 1_000n, 2_000n);
    // Pool A dropped below the liquidity floor and is no longer present.
    const pools = poolSet([v2Pool(POOL_B, USDC, WETH, 5_000n, 9_000n)]);

    assert.equal(
      rebindReserves(pools, [leg]),
      undefined,
      'a missing pool must not silently reuse stale reserves',
    );
  });

  await check('v3 legs pass through untouched', async () => {
    const v3: RouteLeg = {
      venueId: 'uniswap-v3',
      kind: 'univ3',
      router: `0x${'3'.repeat(40)}`,
      tokenIn: USDC,
      tokenOut: WETH,
      feeTier: 500,
      feeBps: 5,
      pool: POOL_B,
    };

    // No V2 pools at all: a pure V3 route must still rebind successfully, since
    // V3 is quoted live against the pool contract.
    const rebound = rebindReserves(poolSet([]), [v3]);
    assert.ok(rebound, 'a V3-only route is always rebindable');
    assert.equal(rebound[0]?.kind, 'univ3');
    assert.equal(rebound[0]?.feeTier, 500);
  });

  await check('a mixed route rebinds only its v2 legs', async () => {
    const legs: RouteLeg[] = [
      v2LegWithPool(USDC, WETH, POOL_A, 1n, 1n),
      {
        venueId: 'uniswap-v3',
        kind: 'univ3',
        router: `0x${'3'.repeat(40)}`,
        tokenIn: WETH,
        tokenOut: USDC,
        feeTier: 500,
        feeBps: 5,
        pool: POOL_B,
      },
    ];
    const pools = poolSet([v2Pool(POOL_A, USDC, WETH, 7_000n, 3_000n)]);

    const rebound = rebindReserves(pools, legs);
    assert.ok(rebound);
    assert.equal(rebound.length, 2);
    assert.equal(rebound[0]?.reserveIn, 7_000n);
    assert.equal(rebound[1]?.kind, 'univ3');
  });

  await check('pool addresses match case-insensitively', async () => {
    // Checksummed in one place, lowercase in another, is normal across sources.
    const leg = v2LegWithPool(USDC, WETH, POOL_A.toUpperCase(), 1n, 1n);
    const pools = poolSet([v2Pool(POOL_A.toLowerCase(), USDC, WETH, 4_000n, 8_000n)]);

    const rebound = rebindReserves(pools, [leg]);
    assert.ok(rebound, 'address casing must not break the lookup');
    assert.equal(rebound[0]?.reserveIn, 4_000n);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

void main();
