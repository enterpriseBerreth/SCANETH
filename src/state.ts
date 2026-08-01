/**
 * In-memory run state: opportunity log, realised PnL, counters.
 *
 * Intentionally not persisted — a restarted arbitrage bot should re-derive
 * everything from the chain rather than trust stale local state. The daily
 * loss ledger resets at UTC midnight.
 */

import type { ArbOpportunity, CexSpread, ExecutionResult } from './types';

const MAX_LOG = 100;

function utcDayKey(at = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

export class BotState {
  readonly startedAt = Date.now();

  private dayKey = utcDayKey();
  private realisedPnlUsdToday = 0;
  private gasSpentUsdToday = 0;

  scansCompleted = 0;
  opportunitiesFound = 0;
  executionsAttempted = 0;
  executionsSucceeded = 0;
  consecutiveFailures = 0;
  lastFailureAt = 0;
  lastScanAt = 0;
  lastError?: string;

  readonly recentOpportunities: ArbOpportunity[] = [];
  readonly recentCexSpreads: CexSpread[] = [];
  readonly recentExecutions: ExecutionResult[] = [];

  private rollDayIfNeeded(): void {
    const current = utcDayKey();
    if (current !== this.dayKey) {
      this.dayKey = current;
      this.realisedPnlUsdToday = 0;
      this.gasSpentUsdToday = 0;
      this.consecutiveFailures = 0;
    }
  }

  get pnlToday(): number {
    this.rollDayIfNeeded();
    return this.realisedPnlUsdToday;
  }

  get gasToday(): number {
    this.rollDayIfNeeded();
    return this.gasSpentUsdToday;
  }

  /** Net loss for today as a positive number, or 0 if we're in profit. */
  get lossToday(): number {
    return Math.max(0, -this.pnlToday);
  }

  recordOpportunity(opp: ArbOpportunity): void {
    this.opportunitiesFound += 1;
    this.recentOpportunities.unshift(opp);
    if (this.recentOpportunities.length > MAX_LOG) this.recentOpportunities.pop();
  }

  recordCexSpread(spread: CexSpread): void {
    this.recentCexSpreads.unshift(spread);
    if (this.recentCexSpreads.length > MAX_LOG) this.recentCexSpreads.pop();
  }

  recordExecution(result: ExecutionResult): void {
    this.rollDayIfNeeded();
    this.recentExecutions.unshift(result);
    if (this.recentExecutions.length > MAX_LOG) this.recentExecutions.pop();

    if (!result.submitted) return;

    this.executionsAttempted += 1;
    if (result.gasSpentUsd) this.gasSpentUsdToday += result.gasSpentUsd;

    const profit = result.realisedProfitUsd ?? 0;
    this.realisedPnlUsdToday += profit;

    if (profit > 0) {
      this.executionsSucceeded += 1;
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      this.lastFailureAt = Date.now();
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      utcDay: this.dayKey,
      scansCompleted: this.scansCompleted,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      opportunitiesFound: this.opportunitiesFound,
      executionsAttempted: this.executionsAttempted,
      executionsSucceeded: this.executionsSucceeded,
      consecutiveFailures: this.consecutiveFailures,
      realisedPnlUsdToday: Number(this.pnlToday.toFixed(2)),
      gasSpentUsdToday: Number(this.gasToday.toFixed(2)),
      lastError: this.lastError ?? null,
      topOpportunities: this.recentOpportunities.slice(0, 10).map((o) => ({
        chain: o.chain,
        route: o.legs.map((l) => `${l.tokenIn.symbol}->${l.tokenOut.symbol}@${l.venueId}`).join(' | '),
        notionalUsd: Number(o.notionalUsd.toFixed(2)),
        grossProfitUsd: Number(o.grossProfitUsd.toFixed(4)),
        gasCostUsd: Number(o.gasCostUsd.toFixed(4)),
        netProfitUsd: Number(o.netProfitUsd.toFixed(4)),
        at: new Date(o.discoveredAt).toISOString(),
      })),
      topCexSpreads: this.recentCexSpreads.slice(0, 10).map((s) => ({
        symbol: s.symbol,
        buy: `${s.buyVenue}@${s.buyPrice}`,
        sell: `${s.sellVenue}@${s.sellPrice}`,
        grossBps: Number(s.grossBps.toFixed(1)),
        netBps: Number(s.netBps.toFixed(1)),
        availableUsd: Number(s.availableUsd.toFixed(0)),
        at: new Date(s.discoveredAt).toISOString(),
      })),
    };
  }
}
