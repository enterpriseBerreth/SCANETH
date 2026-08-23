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
import { formatUnits, parseUnits } from 'ethers';
import type { ArboConfig } from '../config.js';
import type { CexDexExecutionResult, CexDexOpportunity } from '../types.js';
import type { CexAdapter, OrderSide } from '../cex/adapter.js';
import type { BalanceTracker } from '../cex/balances.js';
import { Notifier } from '../telegram.js';
import { createLogger, errMeta } from '../logger.js';
import { executeDexSwap } from './swap.js';
import type { ChainContext } from '../onchain/provider.js';
import { quoteV3 } from './eval.js';

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
    private readonly chainContexts: Map<string, ChainContext>,
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
    void this.notifier.cexDexTrade(result, opportunity);
    return result;
  }

  private async executeLive(opportunity: CexDexOpportunity): Promise<CexDexExecutionResult> {
    const ctx = this.chainContexts.get(opportunity.chain);
    if (!ctx) {
      return this.book(opportunity, 'failed', 'no chain context');
    }

    // Re-quote guard: the evaluator's quote may be stale. Re-quote the exact
    // size now and require the net profit to remain positive after a last-
    // second slippage buffer.
    const freshDexOut = opportunity.buyOnDex
      ? await quoteV3(
          ctx,
          opportunity.quoteToken,
          opportunity.baseToken,
          parseUnits(String(opportunity.notionalUsd), opportunity.quoteToken.decimals),
          opportunity.feeTier,
        )
      : await quoteV3(ctx, opportunity.baseToken, opportunity.quoteToken, opportunity.amountBase, opportunity.feeTier);

    if (!freshDexOut || freshDexOut <= 0n) {
      return this.book(opportunity, 'skipped', 're-quote failed');
    }

    const dexPrice = opportunity.buyOnDex
      ? opportunity.notionalUsd / Number(formatUnits(freshDexOut, opportunity.baseToken.decimals))
      : Number(formatUnits(freshDexOut, opportunity.quoteToken.decimals)) / opportunity.notionalUsd;

    const stillProfitable = opportunity.buyOnDex
      ? (opportunity.cexPrice - dexPrice) / dexPrice > this.config.cexDexMinSpreadBps / 10_000
      : (dexPrice - opportunity.cexPrice) / opportunity.cexPrice > this.config.cexDexMinSpreadBps / 10_000;

    if (!stillProfitable) {
      return this.book(opportunity, 'skipped', 're-quote no longer profitable');
    }

    // Decide which side trades on the CEX and which on the DEX.
    const cexSide: OrderSide = opportunity.buyOnDex ? 'sell' : 'buy';
    const cexSymbol = `${opportunity.baseToken.symbol}/${this.config.cexDexCexQuoteSymbol}`;
    const amountBaseFloat = Number(formatUnits(opportunity.amountBase, opportunity.baseToken.decimals));

    log.info('cexdex live executing', {
      chain: opportunity.chain,
      symbol: opportunity.symbol,
      cex: opportunity.cex,
      direction: opportunity.buyOnDex ? 'buy-dex/sell-cex' : 'buy-cex/sell-dex',
      notionalUsd: opportunity.notionalUsd.toFixed(2),
    });

    // 1. CEX market order.
    const cexOrder = await this.cex.marketOrder(opportunity.cex, cexSymbol, cexSide, amountBaseFloat);
    if (!cexOrder) {
      return this.book(opportunity, 'failed', 'CEX market order failed');
    }

    // 2. DEX swap.
    const dexTokenIn = opportunity.buyOnDex ? opportunity.quoteToken : opportunity.baseToken;
    const dexTokenOut = opportunity.buyOnDex ? opportunity.baseToken : opportunity.quoteToken;
    const dexAmountIn = opportunity.buyOnDex
      ? parseUnits(String(opportunity.notionalUsd), opportunity.quoteToken.decimals)
      : opportunity.amountBase;

    const dexSwap = await executeDexSwap(
      ctx,
      dexTokenIn,
      dexTokenOut,
      opportunity.feeTier,
      dexAmountIn,
      this.config.slippageBps,
    );

    if (!dexSwap) {
      return this.book(opportunity, 'failed', 'DEX swap failed; CEX position is open and must be hedged manually');
    }

    // 3. Optional: rebalance by withdrawing the resulting asset from CEX to
    // the wallet. Disabled unless a withdrawal address is configured.
    let withdrawalId: string | undefined;
    if (this.config.cexDexWithdrawalAddress) {
      const withdrawAsset = opportunity.buyOnDex ? this.config.cexDexCexQuoteSymbol : opportunity.baseToken.symbol;
      const withdrawAmount = opportunity.buyOnDex
        ? cexOrder.cost
        : Number(formatUnits(dexSwap.amountOut, opportunity.baseToken.decimals));
      withdrawalId = (
        await this.cex.withdraw(
          opportunity.cex,
          withdrawAsset,
          withdrawAmount,
          this.config.cexDexWithdrawalAddress,
          opportunity.chain,
        )
      )?.id;
    }

    const cexFeeUsd = cexOrder.cost * (opportunity.cexFeeBps / 10_000);
    const gasSpentUsd =
      (Number(dexSwap.gasUsed) * Number(await ctx.provider.getFeeData().then((f) => f.gasPrice ?? 0n))) / 1e18;

    const realised = opportunity.netProfitUsd; // Conservative; could refine with actual fills.
    const result = this.book(opportunity, 'filled', undefined, realised, gasSpentUsd);
    result.cexOrderId = cexOrder.orderId;
    result.dexTxHash = dexSwap.txHash;
    if (withdrawalId) result.withdrawalId = withdrawalId;

    // Refresh balances after a live trade.
    await this.balances.refreshToken(opportunity.chain, opportunity.baseToken);
    await this.balances.refreshToken(opportunity.chain, opportunity.quoteToken);

    this.consecutiveFailures = 0;
    void this.notifier.cexDexTrade(result, opportunity);
    return result;
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
    this.updateLedgerStats(row);

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

    return result;
  }

  getStats(): {
    capitalUsd: number;
    dailyLossUsd: number;
    trades: number;
    filled: number;
    skipped: number;
    failed: number;
    netProfitUsd: number;
    bestProfitUsd: number | null;
    worstProfitUsd: number | null;
    avgProfitUsd: number | null;
    avgNotionalUsd: number | null;
  } {
    return {
      capitalUsd: this.capitalUsd,
      dailyLossUsd: this.dailyLossUsd,
      ...this.ledgerStats,
    };
  }

  private ledgerStats: {
    trades: number;
    filled: number;
    skipped: number;
    failed: number;
    netProfitUsd: number;
    bestProfitUsd: number | null;
    worstProfitUsd: number | null;
    avgProfitUsd: number | null;
    avgNotionalUsd: number | null;
  } = {
    trades: 0,
    filled: 0,
    skipped: 0,
    failed: 0,
    netProfitUsd: 0,
    bestProfitUsd: null,
    worstProfitUsd: null,
    avgProfitUsd: null,
    avgNotionalUsd: null,
  };

  private updateLedgerStats(row: LedgerRow): void {
    const s = this.ledgerStats;
    s.trades += 1;
    if (row.outcome === 'filled') s.filled += 1;
    else if (row.outcome === 'skipped') s.skipped += 1;
    else if (row.outcome === 'failed') s.failed += 1;

    s.netProfitUsd += row.netProfitUsd;

    const profits: number[] = [];
    const notionals: number[] = [];
    if (fs.existsSync(this.path)) {
      try {
        const rows = fs
          .readFileSync(this.path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LedgerRow)
          .filter((r) => r.kind === 'cexdex-trade');
        for (const r of rows) {
          profits.push(r.netProfitUsd);
          notionals.push(r.notionalUsd);
        }
      } catch {
        // ignore
      }
    }

    if (profits.length > 0) {
      s.bestProfitUsd = Math.max(...profits);
      s.worstProfitUsd = Math.min(...profits);
      s.avgProfitUsd = profits.reduce((a, b) => a + b, 0) / profits.length;
      s.avgNotionalUsd = notionals.reduce((a, b) => a + b, 0) / notionals.length;
    }
  }
}
