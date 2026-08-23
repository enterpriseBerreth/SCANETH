/**
 * CEX-DEX inventory arbitrage engine.
 *
 * Coordinates the CEX adapter, balance tracker, opportunity evaluator, and
 * executor. Runs on its own interval alongside the atomic flash-loan engine.
 */
import type { ArboConfig } from '../config.js';
import { getChain } from '../chains.js';
import type { ChainContext } from '../onchain/provider.js';
import { CexAdapter } from '../cex/adapter.js';
import { BalanceTracker } from '../cex/balances.js';
import { evaluateCexDex } from './eval.js';
import { CexDexExecutor } from './executor.js';
import { createLogger, errMeta } from '../logger.js';
import type { ChainName, CexDexOpportunity } from '../types.js';
import { PriceOracle } from '../onchain/prices.js';
import { Notifier } from '../telegram.js';

const log = createLogger('cexdex-engine');

const SUMMARY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class CexDexEngine {
  private adapter: CexAdapter;
  private balances: BalanceTracker;
  private executor: CexDexExecutor;
  private notifier: Notifier;
  private timer?: NodeJS.Timeout;
  private summaryTimer?: NodeJS.Timeout;
  private stopped = false;
  private chainContexts: Map<ChainName, ChainContext> = new Map();
  private oracles: Map<ChainName, PriceOracle> = new Map();
  private lastSummaryStats = { trades: 0, filled: 0, netProfitUsd: 0 };

  constructor(
    private readonly config: ArboConfig,
    chainContexts: ChainContext[],
  ) {
    this.adapter = new CexAdapter(config);
    this.balances = new BalanceTracker(this.adapter, new Map(chainContexts.map((c) => [c.chain.name, c])));
    this.executor = new CexDexExecutor(config, this.adapter, this.balances, new Map(chainContexts.map((c) => [c.chain.name, c])));
    this.notifier = new Notifier(config);
    for (const ctx of chainContexts) {
      this.chainContexts.set(ctx.chain.name, ctx);
      this.oracles.set(ctx.chain.name, new PriceOracle(ctx.chain));
    }
  }

  getStats(): ReturnType<CexDexExecutor['getStats']> {
    return this.executor.getStats();
  }

  async start(): Promise<void> {
    if (!this.config.cexDexEnabled) {
      log.info('cexdex engine disabled');
      return;
    }

    await this.adapter.init();
    await this.balances.refreshAll();
    log.info('cexdex engine started', {
      pairs: this.config.cexDexPairs.map((p) => `${p.chain}:${p.symbol}/${p.quote}`).join(', '),
      mode: this.config.cexDexMode,
      capitalUsd: this.executor.getStats().capitalUsd.toFixed(2),
    });

    this.scheduleNext();
    this.scheduleSummary();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.config.cexDexScanIntervalMs ?? 15_000);
  }

  private scheduleSummary(): void {
    if (this.stopped) return;
    this.summaryTimer = setTimeout(() => {
      void this.sendSummary();
      this.scheduleSummary();
    }, SUMMARY_INTERVAL_MS);
  }

  private async sendSummary(): Promise<void> {
    if (this.stopped) return;
    const stats = this.executor.getStats();
    const newTrades = stats.trades - this.lastSummaryStats.trades;
    const newFilled = stats.filled - this.lastSummaryStats.filled;
    const newNet = stats.netProfitUsd - this.lastSummaryStats.netProfitUsd;

    if (newTrades === 0) {
      log.info('cexdex summary skipped — no activity');
      return;
    }

    const win = newNet >= 0;
    const sign = win ? '+' : '-';
    const text =
      `<b>CEX-DEX 6h summary</b>\n\n` +
      `Trades: ${newFilled} filled / ${newTrades} evaluated\n` +
      `PNL: <b>${sign}$${Math.abs(newNet).toFixed(2)}</b>\n` +
      `Capital: $${stats.capitalUsd.toFixed(2)}\n` +
      `Best: $${(stats.bestProfitUsd ?? 0).toFixed(2)} · Worst: $${(stats.worstProfitUsd ?? 0).toFixed(2)}\n` +
      `Avg notional: $${(stats.avgNotionalUsd ?? 0).toFixed(0)}`;

    await this.notifier.send(text);
    this.lastSummaryStats = {
      trades: stats.trades,
      filled: stats.filled,
      netProfitUsd: stats.netProfitUsd,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.balances.refreshCex();

      const opportunities: CexDexOpportunity[] = [];
      for (const pair of this.config.cexDexPairs) {
        const ctx = this.chainContexts.get(pair.chain);
        if (!ctx) continue;

        const feeData = await ctx.provider.getFeeData();
        const gasPriceWei = feeData.gasPrice ?? 1_000_000n;

        const oracle = this.oracles.get(pair.chain);
        const nativeUsd = oracle?.nativeUsd() ?? 0;
        if (nativeUsd <= 0) {
          log.warn('no native USD price for cexdex gas costing', { chain: pair.chain });
        }

        for (const exchangeId of this.config.cexExchanges) {
          if (!this.adapter.hasExchange(exchangeId)) continue;

          const cexSymbol = `${pair.symbol}/${this.config.cexDexCexQuoteSymbol}`;
          const quote = await this.adapter.quote(exchangeId, cexSymbol);
          if (!quote) continue;

          const feeBps = await this.adapter.feeBps(exchangeId, cexSymbol);

          const opportunity = await evaluateCexDex(this.config, ctx, {
            chain: pair.chain,
            symbol: pair.symbol,
            quoteSymbol: pair.quote,
            cex: exchangeId,
            cexQuote: quote,
            cexFeeBps: feeBps,
            gasPriceWei,
            nativeUsd,
          });

          if (opportunity) opportunities.push(opportunity);
        }
      }

      if (opportunities.length > 0) {
        opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
        const best = opportunities[0];
        if (best) {
          log.info('cexdex opportunity', {
            chain: best.chain,
            symbol: best.symbol,
            cex: best.cex,
            netProfitUsd: best.netProfitUsd.toFixed(2),
            direction: best.buyOnDex ? 'buy-dex' : 'buy-cex',
          });
          await this.executor.execute(best);
        }
      }
    } catch (err) {
      log.error('cexdex tick failed', errMeta(err));
    } finally {
      this.scheduleNext();
    }
  }
}
