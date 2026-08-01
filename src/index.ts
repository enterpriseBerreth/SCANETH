/**
 * ARBO entry point.
 *
 * Wires the two engines together and runs them on independent cadences:
 *   - the on-chain engine scans every SCAN_INTERVAL_MS per chain
 *   - the CEX engine scans every CEX_SCAN_INTERVAL_MS
 *
 * Scans are scheduled with a self-rescheduling timer rather than setInterval, so
 * a slow RPC round-trip delays the next scan instead of stacking overlapping
 * ones on top of each other.
 */

import { loadConfig, type ArboConfig } from './config';
import { getChain } from './chains';
import { createLogger, errMeta } from './logger';
import { BotState } from './state';
import { Notifier } from './telegram';
import { startServer } from './server';
import { assessRisk, shouldHalt } from './risk';
import { createChainContext, getGasPriceWei, type ChainContext } from './onchain/provider';
import { validateChain, type ChainValidation } from './onchain/validate';
import {
  discoverPools,
  filterV3ByDepth,
  refreshPools,
  v2LiquidityUsd,
  type PoolSet,
} from './onchain/dex';
import { PriceOracle } from './onchain/prices';
import { scanChainVerbose, type ScanDiagnostics } from './onchain/scanner';
import { describeRoute, executeOpportunity } from './onchain/executor';
import { CexFeeds } from './cex/feeds';
import { scanCexSpreads } from './cex/scanner';
import type { ChainName, TokenInfo } from './types';
import type { Server } from 'node:http';

const log = createLogger('arbo');

interface ChainRuntime {
  name: ChainName;
  ctx: ChainContext;
  validation: ChainValidation;
  pools: PoolSet;
  oracle: PriceOracle;
  lastGasPriceWei: bigint;
  lastScanDurationMs: number;
  lastScanError?: string;
  lastDiagnostics?: ScanDiagnostics;
}

class Arbo {
  private readonly state = new BotState();
  private readonly notifier: Notifier;
  private readonly runtimes: ChainRuntime[] = [];
  private cexFeeds?: CexFeeds;
  private httpServer?: Server;
  private stopping = false;
  private halted = false;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly config: ArboConfig) {
    this.notifier = new Notifier(config);
  }

  // ── startup ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.banner();

    this.httpServer = startServer({
      config: this.config,
      state: this.state,
      describeChains: () => this.describeChains(),
    });

    await this.initChains();

    if (this.config.cexEnabled) {
      await this.initCex();
    }

    if (this.runtimes.length === 0 && !this.cexFeeds) {
      log.error('no usable chains and no CEX feeds — nothing to do');
      process.exitCode = 1;
      return;
    }

    await this.notifier.startup(
      this.runtimes.map((r) => r.name),
      this.config.mode,
    );

    if (this.config.runOnce) {
      log.info('running a single scan pass (--once)');
      await Promise.all(this.runtimes.map((runtime) => this.scanOnchain(runtime)));
      if (this.cexFeeds) await this.scanCex();
      log.info('single pass complete', this.state.snapshot());
      await this.shutdown();
      return;
    }

    for (const runtime of this.runtimes) {
      this.scheduleOnchain(runtime, 0);
    }
    if (this.cexFeeds) {
      this.scheduleCex(2_000);
    }
  }

  private banner(): void {
    log.info('ARBO starting', {
      mode: this.config.mode,
      chains: this.config.chains,
      minProfitUsd: this.config.minProfitUsd,
      tradeRangeUsd: [this.config.minTradeUsd, this.config.maxTradeUsd],
      maxDailyLossUsd: this.config.maxDailyLossUsd,
      cexEnabled: this.config.cexEnabled,
    });

    if (this.config.mode === 'simulate') {
      log.info(
        'SIMULATE MODE — opportunities will be scored and logged, but no transaction will ever be sent',
      );
    } else {
      log.warn('LIVE MODE — real transactions will be broadcast with real funds');
    }
  }

  private async initChains(): Promise<void> {
    for (const chainName of this.config.chains) {
      const chain = getChain(chainName);
      const ctx = createChainContext(this.config, chain);

      try {
        const validation = await validateChain(ctx);
        if (!validation.chainOk) {
          log.error('chain unusable, skipping', { chain: chainName });
          continue;
        }
        if (validation.enabledVenueIds.size < 2) {
          log.warn('fewer than two usable venues — cross-venue arbitrage impossible', {
            chain: chainName,
            venues: [...validation.enabledVenueIds],
          });
        }

        const discovered = await discoverPools(ctx, validation.enabledVenueIds);
        if (discovered.v2.length + discovered.v3.length === 0) {
          log.warn('no pools discovered, skipping chain', { chain: chainName });
          continue;
        }

        // Discovery only resolves addresses — reserves are still zero at this
        // point, so they must be fetched before anything can be measured. Doing
        // this in the wrong order silently values every pool at $0, drops them
        // all, and takes the price oracle down with them.
        const pools = await refreshPools(ctx, discovered);

        // Now prices are derivable, and those prices are what make the depth
        // filter meaningful.
        const oracle = new PriceOracle(chain);
        oracle.refresh(pools);

        const priceOf = (token: TokenInfo): number => oracle.usd(token);

        // V3 depth is measured directly and is structurally stable, so this
        // one-time multicall is worth it and the result can persist.
        const { kept, dropped } = await filterV3ByDepth(
          ctx,
          pools.v3,
          this.config.minPoolLiquidityUsd,
          priceOf,
        );
        pools.v3 = kept;

        // V2 depth is re-evaluated every scan from fresh reserves, so the master
        // list is left intact here and only reported.
        const v2Active = pools.v2.filter(
          (p) => v2LiquidityUsd(p, priceOf) >= this.config.minPoolLiquidityUsd,
        ).length;

        log.info('liquidity filter applied', {
          chain: chainName,
          minLiquidityUsd: this.config.minPoolLiquidityUsd,
          v2Active: `${v2Active}/${pools.v2.length}`,
          v3Kept: `${pools.v3.length}/${pools.v3.length + dropped}`,
          nativeUsd: Number(oracle.nativeUsd().toFixed(2)),
        });

        if (v2Active + pools.v3.length === 0) {
          log.warn('every pool was below the liquidity floor, skipping chain', {
            chain: chainName,
            minLiquidityUsd: this.config.minPoolLiquidityUsd,
          });
          continue;
        }

        this.runtimes.push({
          name: chainName,
          ctx,
          validation,
          pools,
          oracle,
          lastGasPriceWei: 0n,
          lastScanDurationMs: 0,
        });
      } catch (err) {
        log.error('chain initialisation failed', { chain: chainName, ...errMeta(err) });
      }
    }

    log.info('chains ready', { chains: this.runtimes.map((r) => r.name) });
  }

  private async initCex(): Promise<void> {
    const feeds = new CexFeeds(this.config.cexExchanges);
    try {
      const ready = await feeds.init();
      if (ready.length < 2) {
        log.warn('fewer than two CEX venues available — cross-venue spreads impossible', {
          ready,
        });
        if (ready.length === 0) return;
      }
      this.cexFeeds = feeds;
    } catch (err) {
      log.warn('CEX initialisation failed, continuing without it', errMeta(err));
    }
  }

  // ── scheduling ────────────────────────────────────────────────────────────

  private scheduleOnchain(runtime: ChainRuntime, delayMs: number): void {
    if (this.stopping) return;
    const timer = setTimeout(async () => {
      await this.scanOnchain(runtime);
      this.scheduleOnchain(runtime, this.config.scanIntervalMs);
    }, delayMs);
    this.timers.push(timer);
  }

  private scheduleCex(delayMs: number): void {
    if (this.stopping) return;
    const timer = setTimeout(async () => {
      await this.scanCex();
      this.scheduleCex(this.config.cexScanIntervalMs);
    }, delayMs);
    this.timers.push(timer);
  }

  // ── on-chain engine ───────────────────────────────────────────────────────

  private async scanOnchain(runtime: ChainRuntime): Promise<void> {
    if (this.stopping) return;

    const haltReason = shouldHalt(this.config, this.state);
    if (haltReason) {
      if (!this.halted) {
        this.halted = true;
        log.error('trading halted', { reason: haltReason });
        await this.notifier.halted(haltReason);
      }
      return;
    }

    const startedAt = Date.now();

    try {
      // Refresh reserves on the master set, unfiltered. `runtime.pools` stays the
      // source of truth: filtering it in place would be a ratchet, where a single
      // transient bad price permanently deletes pools that can never come back.
      runtime.pools = await refreshPools(runtime.ctx, runtime.pools);
      runtime.oracle.refresh(runtime.pools);
      runtime.lastGasPriceWei = await getGasPriceWei(runtime.ctx.provider);

      if (runtime.oracle.nativeUsd() <= 0) {
        log.warn('no native price available, skipping scan', { chain: runtime.name });
        return;
      }

      // Derive this pass's working set from live prices. Dead pools are excluded
      // per-scan rather than destroyed, so they rejoin automatically if depth
      // returns.
      const floor = this.config.minPoolLiquidityUsd;
      const scanPools: PoolSet = {
        v2: runtime.pools.v2.filter(
          (p) => v2LiquidityUsd(p, (t) => runtime.oracle.usd(t)) >= floor,
        ),
        v3: runtime.pools.v3,
      };

      const { actionable, nearMisses, diagnostics } = await scanChainVerbose({
        ctx: runtime.ctx,
        pools: scanPools,
        oracle: runtime.oracle,
        config: this.config,
        gasPriceWei: runtime.lastGasPriceWei,
      });

      this.state.scansCompleted += 1;
      this.state.lastScanAt = Date.now();
      runtime.lastScanDurationMs = Date.now() - startedAt;
      runtime.lastScanError = undefined;
      runtime.lastDiagnostics = diagnostics;

      if (actionable.length === 0) {
        // Near misses plus stage counters are what make a quiet scan
        // interpretable: bestEdgeBps shows how far the market actually was from
        // break-even, and a null there means nothing got priced at all.
        log.info('scan complete — no actionable opportunities', {
          chain: runtime.name,
          v2Pools: scanPools.v2.length,
          v3Pools: scanPools.v3.length,
          durationMs: runtime.lastScanDurationMs,
          cyclesScreened: diagnostics.cyclesScreened,
          trianglesEnumerated: diagnostics.trianglesEnumerated,
          cyclesConfirmed: diagnostics.cyclesConfirmed,
          cyclesUnprofitable: diagnostics.cyclesUnprofitable,
          quotesImplausible: diagnostics.quotesImplausible,
          bestEdgeBps:
            diagnostics.bestEdgeBps === null
              ? null
              : Number(diagnostics.bestEdgeBps.toFixed(2)),
          bestEdgeRoute: diagnostics.bestEdgeRoute,
          bestNearMissUsd: nearMisses[0]
            ? Number(nearMisses[0].netProfitUsd.toFixed(4))
            : null,
          nativeUsd: Number(runtime.oracle.nativeUsd().toFixed(2)),
        });
        return;
      }

      log.info('opportunities found', {
        chain: runtime.name,
        count: actionable.length,
        durationMs: runtime.lastScanDurationMs,
      });

      for (const opportunity of actionable) {
        if (this.stopping) return;

        this.state.recordOpportunity(opportunity);
        const route = describeRoute(opportunity);

        log.info('opportunity', {
          chain: runtime.name,
          route,
          notionalUsd: Number(opportunity.notionalUsd.toFixed(2)),
          grossUsd: Number(opportunity.grossProfitUsd.toFixed(4)),
          gasUsd: Number(opportunity.gasCostUsd.toFixed(4)),
          netUsd: Number(opportunity.netProfitUsd.toFixed(4)),
        });

        await this.notifier.opportunity(opportunity, route);

        const verdict = assessRisk(this.config, this.state, opportunity);
        if (!verdict.allowed) {
          log.info('opportunity blocked by risk engine', { route, reason: verdict.reason });
          continue;
        }

        const result = await executeOpportunity(
          { ctx: runtime.ctx, config: this.config, oracle: runtime.oracle },
          opportunity,
        );

        this.state.recordExecution(result);

        if (result.submitted) {
          await this.notifier.executed(result, route);
        } else {
          log.info('not executed', { route, reason: result.reason });
        }

        // One trade per scan: after executing, pool state is stale.
        if (result.submitted) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.lastScanError = message;
      this.state.lastError = message;
      log.error('scan failed', { chain: runtime.name, ...errMeta(err) });
    }
  }

  // ── CEX engine ────────────────────────────────────────────────────────────

  private async scanCex(): Promise<void> {
    if (this.stopping || !this.cexFeeds) return;

    try {
      const spreads = await scanCexSpreads(this.cexFeeds, this.config);

      if (spreads.length === 0) {
        log.info('cex scan complete — no spreads above threshold', {
          minSpreadBps: this.config.cexMinSpreadBps,
        });
        return;
      }

      for (const spread of spreads.slice(0, 5)) {
        this.state.recordCexSpread(spread);
        log.info('cex spread', {
          symbol: spread.symbol,
          buy: `${spread.buyVenue}@${spread.buyPrice}`,
          sell: `${spread.sellVenue}@${spread.sellPrice}`,
          netBps: Number(spread.netBps.toFixed(1)),
          availableUsd: Number(spread.availableUsd.toFixed(0)),
          note: 'requires pre-funded inventory on both venues — not flash-loanable',
        });
        await this.notifier.cexSpread(spread);
      }
    } catch (err) {
      log.error('cex scan failed', errMeta(err));
    }
  }

  // ── observability ─────────────────────────────────────────────────────────

  private describeChains(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const runtime of this.runtimes) {
      out[runtime.name] = {
        chainId: runtime.ctx.chain.chainId,
        contract: runtime.ctx.contractAddress ?? null,
        canExecute: this.config.mode === 'live' && !!runtime.ctx.contractAddress,
        enabledVenues: [...runtime.validation.enabledVenueIds],
        disabledVenues: runtime.validation.disabled,
        v2Pools: runtime.pools.v2.length,
        v3Pools: runtime.pools.v3.length,
        gasPriceGwei: Number(runtime.lastGasPriceWei) / 1e9,
        prices: runtime.oracle.snapshot(),
        lastScanDurationMs: runtime.lastScanDurationMs,
        lastScanError: runtime.lastScanError ?? null,
        lastScan: runtime.lastDiagnostics ?? null,
      };
    }
    return out;
  }

  // ── shutdown ──────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info('shutting down', this.state.snapshot());

    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];

    await this.cexFeeds?.close();

    // Every handle below keeps the event loop alive. Without closing them a
    // `--once` run scans correctly and then hangs forever instead of exiting,
    // which would make the same code unusable as a one-shot CI/cron check.
    for (const runtime of this.runtimes) {
      try {
        runtime.ctx.provider.destroy();
        if (runtime.ctx.submitProvider !== runtime.ctx.provider) {
          runtime.ctx.submitProvider.destroy();
        }
      } catch {
        // Already torn down; nothing to salvage.
      }
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = undefined;
    }
  }
}

// ── bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let config: ArboConfig;
  try {
    config = loadConfig();
  } catch (err) {
    // Configuration errors must be loud and fatal, never silently defaulted.
    console.error(`\nARBO configuration error:\n${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  const bot = new Arbo(config);

  const stop = (signal: string) => {
    log.info(`received ${signal}`);
    void bot.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', errMeta(reason));
  });

  await bot.start();
}

void main();
