/**
 * CEX-DEX executor and paper ledger.
 *
 * This module handles both modes:
 * - paper: simulate fills at the quoted prices, book P&L, alert Telegram.
 * - live: place CEX market order, submit DEX swap, record result.
 *
 * Safety guards:
 * - Max daily loss limit
 * - Max exposure per trade
 * - Cooldown after consecutive failures
 * - Require balance tracker to confirm inventory
 */
import fs from 'fs';
import type { ArboConfig } from '../config.js';
import type { CexDexExecutionResult, CexDexOpportunity } from '../types.js';
import type { CexAdapter } from '../cex/adapter.js';
import type { BalanceTracker } from '../cex/balances.js';
import { Notifier } from '../telegram.js';
import { createLogger, errMeta } from '../logger.js';

const log = createLogger('cexdex');

interface LedgerRow {
  kind: 'cexdex-trade';
  version: number;
  opportunityId: string;
  chain: string;
  symbol: string;
  cex: string;
  buyOnDex: boolean;
  outcome: 'filled' | 'reverted' | 'skipped' | 'failed';
  notionalUsd: number;
  netProfitUsd: number;
  capitalBeforeUsd: number;
  capitalAfterUsd: number;
  realisedProfitUsd?: number;
  gasSpentUsd?: number;
  reason?: string;
  timestamp: number;
}

export class CexDexExecutor {
  private capitalUsd: number;
  private dailyLossUsd = 0;
  private consecutiveFailures = 0;
  private lastFailureTs = 0;
  private readonly path: string;
  private readonly notifier: Notifier;

  constructor(
    private readonly config: ArboConfig,
    private readonly cex: CexAdapter,
    private readonly balances: BalanceTracker,
  ) {
    this.path = config.paperLedgerPath.replace(/\.jsonl$/, '-cexdex.jsonl');
    this.capitalUsd = config.paperStartingCapitalUsd;
    this.notifier = new Notifier(config);
    this.loadLedger();
  }

  private loadLedger(): void {
    if (!fs.existsSync(this.path)) return;
    try {
      const rows = fs
        .readFileSync(this.path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerRow);
      let net = 0;
      for (const row of rows) {
        if (row.kind !== 'cexdex-trade') continue;
        net += row.netProfitUsd;
      }
      this.capitalUsd += net;
      log.info('cexdex paper ledger loaded', { path: this.path, trades: rows.length, capitalUsd: this.capitalUsd });
    } catch (err) {
      log.warn('cexdex ledger load failed', errMeta(err));
    }
  }

  private append(row: LedgerRow): void {
    try {
      fs.appendFileSync(this.path, JSON.stringify(row) + '\n');
    } catch (err) {
      log.warn('cexdex ledger append failed', errMeta(err));
    }
  }

  private cooldownActive(): boolean {
    if (this.consecutiveFailures < this.config.maxConsecutiveFailures) return false;
    return Date.now() - this.lastFailureTs < this.config.failureCooldownMs;
  }

  /**
   * Attempt to execute a CEX-DEX round trip. In paper mode this simulates the
   * fill; in live mode it places real orders.
   */
  async execute(opportunity: CexDexOpportunity): Promise<CexDexExecutionResult> {
    if (this.cooldownActive()) {
      return this.book(opportunity, 'skipped', 'failure cooldown active');
    }
    if (this.dailyLossUsd >= this.config.maxDailyLossUsd) {
      return this.book(opportunity, 'skipped', 'daily loss limit reached');
    }
    if (opportunity.notionalUsd > this.config.cexDexMaxTradeUsd) {
      return this.book(opportunity, 'skipped', 'exceeds max trade size');
    }

    const funding = this.balances.canFund(
      opportunity.cex,
      opportunity.chain,
      opportunity.baseToken.symbol,
      opportunity.quoteToken.symbol,
      opportunity.buyOnDex,
      opportunity.notionalUsd,
    );
    if (!funding.ok) {
      return this.book(opportunity, 'skipped', funding.reason ?? 'insufficient inventory');
    }

    if (this.config.cexDexMode === 'paper') {
      return this.simulate(opportunity);
    }

    return this.executeLive(opportunity);
  }

  private simulate(opportunity: CexDexOpportunity): CexDexExecutionResult {
    // Paper simulation assumes the quoted prices fill exactly. Slippage and
    // transfer cost are already deducted in the evaluator, so the net profit
    // here is the expected net.
    const realised = opportunity.netProfitUsd;
    const result = this.book(opportunity, 'filled', undefined, realised, opportunity.gasCostUsd);
    this.consecutiveFailures = 0;
    return result;
  }

  private async executeLive(opportunity: CexDexOpportunity): Promise<CexDexExecutionResult> {
    // TODO: implement live CEX order + DEX swap. This is intentionally left as
    // a stub because live mode requires funded API keys, withdrawal addresses,
    // and a DEX swap router integration. The paper path proves the strategy
    // first.
    return this.book(opportunity, 'failed', 'live execution not yet implemented');
  }

  private book(
    opportunity: CexDexOpportunity,
    outcome: 'filled' | 'reverted' | 'skipped' | 'failed',
    reason?: string,
    realisedProfitUsd?: number,
    gasSpentUsd?: number,
  ): CexDexExecutionResult {
    const capitalBefore = this.capitalUsd;
    const net = realisedProfitUsd ?? 0;
    this.capitalUsd += net;
    if (net < 0) {
      this.dailyLossUsd += Math.abs(net);
      this.consecutiveFailures += 1;
      this.lastFailureTs = Date.now();
    }

    const row: LedgerRow = {
      kind: 'cexdex-trade',
      version: 1,
      opportunityId: opportunity.id,
      chain: opportunity.chain,
      symbol: opportunity.symbol,
      cex: opportunity.cex,
      buyOnDex: opportunity.buyOnDex,
      outcome,
      notionalUsd: opportunity.notionalUsd,
      netProfitUsd: net,
      capitalBeforeUsd: capitalBefore,
      capitalAfterUsd: this.capitalUsd,
      realisedProfitUsd,
      gasSpentUsd,
      reason,
      timestamp: Date.now(),
    };

    this.append(row);

    const result: CexDexExecutionResult = {
      opportunityId: opportunity.id,
      submitted: outcome === 'filled',
      outcome,
      reason,
      realisedProfitUsd,
      gasSpentUsd,
      capitalBeforeUsd: capitalBefore,
      capitalAfterUsd: this.capitalUsd,
      completedAt: Date.now(),
    };

    if (outcome === 'filled') {
      void this.notifier.cexDexTrade(result, opportunity);
    }

    return result;
  }

  getStats(): { capitalUsd: number; dailyLossUsd: number } {
    return { capitalUsd: this.capitalUsd, dailyLossUsd: this.dailyLossUsd };
  }
}
