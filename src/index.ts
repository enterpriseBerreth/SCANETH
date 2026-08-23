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
import { AAVE_FLASH_FEE_BPS, BALANCER_FLASH_FEE_BPS, getChain } from './chains';
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
  solidlyLiquidityUsd,
  v2LiquidityUsd,
  allPools,
  liquidityFloorFor,
  type PoolSet,
} from './onchain/dex';
import { PriceOracle } from './onchain/prices';
import { BlockWatcher } from './onchain/blocks';
import { PoolActivityTracker } from './onchain/dirty';
import { CexDexEngine } from './cexdex/index.js';
import {
  scanChainVerbose,
  requoteCycle,
  ScreenPriceCache,
  type ScanDiagnostics,
} from './onchain/scanner';
import { describeRoute, executeOpportunity } from './onchain/executor';
import { estimateRouteGas, flashFee, gasCostUsd, valueUsd } from './onchain/profit';
import { PaperLedger, type PendingPaperTrade } from './paper';
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
  /** Set while a scan is in flight, so block events cannot stack up scans. */
  scanning?: boolean;
  /** Most recent block that triggered a scan, for observability. */
  lastScanBlock?: number;
  /** How scans are currently being triggered. */
  trigger?: 'block' | 'poll';
  /** Live block subscription, torn down on shutdown. */
  blockWatcher?: BlockWatcher;
  /** Log-derived pool activity, so untouched pools are not re-quoted. */
  activity?: PoolActivityTracker;
  /** Screen prices carried between passes for pools that did not trade. */
  screenCache: ScreenPriceCache;
}

class Arbo {
  private readonly state = new BotState();
  private readonly notifier: Notifier;
  private readonly paper: PaperLedger;
  private readonly runtimes: ChainRuntime[] = [];
  private cexFeeds?: CexFeeds;
  private cexDexEngine?: CexDexEngine;
  private httpServer?: Server;
  private stopping = false;
  private halted = false;
  private timers: NodeJS.Timeout[] = [];
  /** Ensures the insolvency alert fires once, not on every subsequent settlement. */
  private paperInsolvencyReported = false;

  constructor(private readonly config: ArboConfig) {
    this.notifier = new Notifier(config);
    this.paper = new PaperLedger(
      config.paperLedgerPath,
      config.paperProfitFloorUsd(config.mode),
      config.paperStartingCapitalUsd,
    );
  }

  // ── startup ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.banner();

    this.httpServer = startServer({
      config: this.config,
      state: this.state,
      describeChains: () => this.describeChains(),
      paperStats: () => this.paper.stats(),
      paperTrades: () => this.paper.recentTrades(),
      paperDurable: () => this.paper.isWritable,
      paperLedgerPath: () => this.paper.ledgerPath,
      cexDexStats: () => this.cexDexEngine?.getStats(),
    });

    if (this.config.mode === 'paper') {
      await this.paper.load();
    }

    await this.initChains();

    if (this.config.cexEnabled) {
      await this.initCex();
    }

    if (this.config.cexDexEnabled) {
      await this.initCexDex();
    }

    if (this.runtimes.length === 0 && !this.cexFeeds && !this.cexDexEngine) {
      log.error('no usable chains and no CEX feeds — nothing to do');
      process.exitCode = 1;
      return;
    }

    // Startup is logged, not alerted. Every message in the Telegram stream is
    // meant to be a settled trade with a realised P&L, so a redeploy must not
    // inject a message that has no trade behind it.
    log.info('engines started', {
      chains: this.runtimes.map((r) => r.name),
      mode: this.config.mode,
      telegram: this.notifier.isEnabled ? 'enabled' : 'disabled',
      cexDex: this.config.cexDexEnabled ? this.config.cexDexMode : 'disabled',
    });

    // Boot-time connectivity probe is opt-in for the same reason. Redeploys are
    // frequent and this would otherwise be the most common message in the chat.
    // `npm run telegram:test` is the intended way to verify delivery.
    if (this.notifier.isEnabled && this.config.telegramTestOnBoot) {
      const ok = await this.notifier.test(this.config.mode, this.paper.capital);
      if (ok) {
        log.info('telegram connected — test alert delivered');
      } else {
        log.error(
          'telegram test alert was NOT delivered — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, ' +
            'and make sure the chat has been started with the bot',
        );
      }
    }

    if (this.config.runOnce) {
      log.info('running a single scan pass (--once)');
      await Promise.all(this.runtimes.map((runtime) => this.scanOnchain(runtime)));
      if (this.cexFeeds) await this.scanCex();
      log.info('single pass complete', this.state.snapshot());
      await this.shutdown();
      return;
    }

    for (const runtime of this.runtimes) {
      // The timer chain remains as a safety net; block events are the fast path.
      this.scheduleOnchain(runtime, 0);
      this.startOnchainTriggers(runtime);
    }
    if (this.cexFeeds) {
      this.scheduleCex(2_000);
    }
    if (this.config.mode === 'paper') {
      this.schedulePaperReport(this.config.paperReportIntervalMs);
    }
  }

  private banner(): void {
    log.info('ARBO starting', {
      mode: this.config.mode,
      chains: this.config.chains,
      minProfitUsd: this.config.minProfitUsd,
      paperProfitFloorUsd: this.config.paperProfitFloorUsd(this.config.mode),
      tradeRangeUsd: [this.config.minTradeUsd, this.config.maxTradeUsd],
      maxDailyLossUsd: this.config.maxDailyLossUsd,
      cexEnabled: this.config.cexEnabled,
    });

    if (this.config.mode === 'simulate') {
      log.info(
        'SIMULATE MODE — opportunities will be scored and logged, but no transaction will ever be sent',
      );
    } else if (this.config.mode === 'paper') {
      log.info(
        'PAPER MODE — no transaction will ever be sent. Every candidate is re-quoted ' +
          'on-chain after a delay and booked at that second price, net of gas.',
        {
          settleDelayMs: this.config.paperSettleDelayMs,
          ledger: this.config.paperLedgerPath,
          reportIntervalMs: this.config.paperReportIntervalMs,
        },
      );
      log.info(
        'Paper results do NOT model competition or inclusion risk, so real fill rates ' +
          'would be lower than reported, never higher.',
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
        const startupFloors = {
          volatileUsd: this.config.minPoolLiquidityUsd,
          stableUsd: this.config.minStablePoolLiquidityUsd,
        };
        const v2Active = pools.v2.filter(
          (p) => v2LiquidityUsd(p, priceOf) >= liquidityFloorFor(p, startupFloors),
        ).length;
        const solidlyActive = pools.solidly.filter(
          (p) => solidlyLiquidityUsd(p, priceOf) >= liquidityFloorFor(p, startupFloors),
        ).length;

        log.info('liquidity filter applied', {
          chain: chainName,
          minLiquidityUsd: this.config.minPoolLiquidityUsd,
          minStableLiquidityUsd: this.config.minStablePoolLiquidityUsd,
          v2Active: `${v2Active}/${pools.v2.length}`,
          solidlyActive: `${solidlyActive}/${pools.solidly.length}`,
          v3Kept: `${pools.v3.length}/${pools.v3.length + dropped}`,
          nativeUsd: Number(oracle.nativeUsd().toFixed(2)),
        });

        if (v2Active + solidlyActive + pools.v3.length + pools.curve.length === 0) {
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
          screenCache: new ScreenPriceCache(),
        });
      } catch (err) {
        log.error('chain initialisation failed', { chain: chainName, ...errMeta(err) });
      }
    }

    log.info('chains ready', { chains: this.runtimes.map((r) => r.name) });
  }

  private async initCexDex(): Promise<void> {
    const engine = new CexDexEngine(this.config, this.runtimes.map((r) => r.ctx));
    this.cexDexEngine = engine;
    await engine.start();
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

  /**
   * Drive scans from block arrivals rather than a fixed timer.
   *
   * A block event means the state every quote depends on has just changed, which
   * is the only moment a rescan is actually informative. Two guards matter:
   *
   *  - `scanning` drops overlapping triggers instead of queueing them. On a 2s
   *    chain with a 2.2s scan, queueing would build an unbounded backlog of
   *    scans each describing an older block than the last.
   *  - a slow safety-net timer still runs, so if the chain stalls or every block
   *    trigger is dropped the bot keeps scanning rather than going silent.
   */
  private startOnchainTriggers(runtime: ChainRuntime): void {
    const watcher = new BlockWatcher({
      chainName: runtime.name,
      wsUrl: this.config.wsUrls[runtime.name],
      httpProvider: runtime.ctx.provider,
      pollIntervalMs: this.config.blockPollIntervalMs,
      onBlock: (blockNumber) => {
        if (this.stopping) return;
        if (runtime.scanning) return;
        runtime.lastScanBlock = blockNumber;
        runtime.trigger = watcher.triggerMode;
        void this.scanOnchain(runtime);
      },
    });

    runtime.blockWatcher = watcher;
    watcher.start();

    // Watch the pools' own logs so the scanner can tell what actually moved.
    // Quoted venues (V3, Curve) dominate the scan's RPC bill, and on a typical
    // block almost none of them traded — re-quoting them all is paying full
    // price for numbers that did not change.
    const activity = new PoolActivityTracker({
      chainName: runtime.name,
      pools: allPools(runtime.pools).map((p) => p.pool),
      wsUrl: this.config.wsUrls[runtime.name],
      logsRpcUrls: this.config.logsRpcUrls[runtime.name],
      pollIntervalMs: this.config.blockPollIntervalMs,
      maxCleanBlocks: this.config.maxCleanBlocks,
    });
    runtime.activity = activity;
    activity.start();
  }

  private scheduleOnchain(runtime: ChainRuntime, delayMs: number): void {
    if (this.stopping) return;
    const timer = setTimeout(async () => {
      // Skipped when block triggers are keeping the chain fresh on their own.
      if (!runtime.scanning) await this.scanOnchain(runtime);
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

  private schedulePaperReport(delayMs: number): void {
    if (this.stopping) return;
    const timer = setTimeout(async () => {
      await this.reportPaper();
      this.schedulePaperReport(this.config.paperReportIntervalMs);
    }, delayMs);
    this.timers.push(timer);
  }

  /**
   * Persist the market-conditions rollup and log cumulative performance.
   *
   * The rollup is what makes a zero-trade result mean something: without a record
   * of how close the market actually came, an empty ledger is indistinguishable
   * from a broken scanner.
   */
  private async reportPaper(): Promise<void> {
    await this.paper.flushMarketSamples();
    const stats = this.paper.stats();

    log.info('paper trading report', {
      trades: stats.trades,
      filled: stats.filled,
      reverted: stats.reverted,
      dead: stats.dead,
      skipped: stats.skipped,
      fillRate: stats.fillRate,
      netUsd: stats.netUsd,
      grossUsd: stats.grossUsd,
      gasUsd: stats.gasUsd,
      avgNetUsd: stats.avgNetUsd,
      avgDecayBps: stats.avgDecayBps,
      liveEligible: stats.liveEligible,
      liveEligibleNetUsd: stats.liveEligibleNetUsd,
      pending: this.paper.pendingCount,
      durable: this.paper.isWritable,
    });
  }

  // ── on-chain engine ───────────────────────────────────────────────────────

  private async scanOnchain(runtime: ChainRuntime): Promise<void> {
    if (this.stopping) return;
    // Overlapping scans are dropped, not queued: a backlog would only ever
    // produce results describing progressively staler blocks.
    if (runtime.scanning) return;

    const haltReason = shouldHalt(this.config, this.state);
    if (haltReason) {
      if (!this.halted) {
        this.halted = true;
        log.error('trading halted', { reason: haltReason });
        await this.notifier.halted(haltReason);
      }
      return;
    }

    runtime.scanning = true;
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
      //
      // The floor is per-curve, not global. A flat-invariant pool absorbs the
      // same notional on roughly a tenth of the depth, and holding it to the
      // constant-product number was deleting the stable pools that the cheapest
      // cycles are built from.
      const floors = {
        volatileUsd: this.config.minPoolLiquidityUsd,
        stableUsd: this.config.minStablePoolLiquidityUsd,
      };
      const priceOf = (t: TokenInfo): number => runtime.oracle.usd(t);
      const scanPools: PoolSet = {
        v2: runtime.pools.v2.filter(
          (p) => v2LiquidityUsd(p, priceOf) >= liquidityFloorFor(p, floors),
        ),
        v3: runtime.pools.v3,
        // Solidly pools carry reserves like V2, so the same measurement applies —
        // but a stable pool is held to the stable floor.
        solidly: runtime.pools.solidly.filter(
          (p) => solidlyLiquidityUsd(p, priceOf) >= liquidityFloorFor(p, floors),
        ),
        // Curve holds no cached reserves here — depth is only knowable from an
        // on-chain read, so filtering locally would either be a guess or a lie.
        // Shallow Curve pools are instead rejected downstream when the quoted
        // output fails the profit check.
        curve: runtime.pools.curve,
      };

      const scanCtx = {
        ctx: runtime.ctx,
        pools: scanPools,
        oracle: runtime.oracle,
        config: this.config,
        gasPriceWei: runtime.lastGasPriceWei,
        // Stamped from the block that triggered this pass, before any quoting.
        // Using the block current at quote time instead would let an event that
        // landed mid-scan mark a stale quote as fresh.
        block: runtime.lastScanBlock ?? 0,
        activity: runtime.activity,
        screenCache: runtime.screenCache,
      };

      // Settle before scanning. Pool state was just refreshed, so this is the
      // freshest view available, and settling first means a candidate re-detected
      // in this same pass cannot overwrite the pending entry it is about to be
      // measured against.
      if (this.config.mode === 'paper') {
        await this.settlePaperTrades(runtime, scanCtx);
      }

      const { actionable, nearMisses, diagnostics } = await scanChainVerbose(scanCtx);

      this.state.scansCompleted += 1;
      this.state.lastScanAt = Date.now();
      runtime.lastScanDurationMs = Date.now() - startedAt;
      runtime.lastScanError = undefined;
      runtime.lastDiagnostics = diagnostics;

      // Paper mode books every genuinely profitable cycle, not only those
      // clearing MIN_PROFIT_USD. Recording just the ones above the live floor
      // would leave the ledger empty whenever the floor is not met, which proves
      // nothing either way — the point of paper trading is to gather evidence.
      const paperCandidates =
        this.config.mode === 'paper'
          ? [...actionable, ...nearMisses].filter((o) => o.netProfitUsd > 0)
          : [];

      if (this.config.mode === 'paper') {
        this.paper.noteScan(
          runtime.name,
          // Results are sorted by net descending, so the best is the head of
          // `actionable` when non-empty and otherwise the head of `nearMisses`.
          actionable[0]?.netProfitUsd ?? nearMisses[0]?.netProfitUsd ?? null,
          diagnostics.bestEdgeBps,
          paperCandidates.length,
        );

        for (const candidate of paperCandidates) {
          // An account with no money cannot pay gas, so it cannot open a trade.
          // Continuing to book fills past this point would be fiction.
          if (!this.paper.solvent) break;
          const route = describeRoute(candidate);
          if (this.paper.open(candidate, route, this.config.paperSettleDelayMs)) {
            log.info('paper candidate queued', {
              chain: runtime.name,
              route,
              notionalUsd: Number(candidate.notionalUsd.toFixed(2)),
              expectedNetUsd: Number(candidate.netProfitUsd.toFixed(4)),
              settlesInMs: this.config.paperSettleDelayMs,
            });
          }
        }
      }

      if (actionable.length === 0) {
        // Near misses plus stage counters are what make a quiet scan
        // interpretable: bestEdgeBps shows how far the market actually was from
        // break-even, and a null there means nothing got priced at all.
        log.info('scan complete — no actionable opportunities', {
          chain: runtime.name,
          v2Pools: scanPools.v2.length,
          v3Pools: scanPools.v3.length,
          solidlyPools: scanPools.solidly.length,
          curvePools: scanPools.curve.length,
          durationMs: runtime.lastScanDurationMs,
          block: runtime.lastScanBlock ?? null,
          trigger: runtime.trigger ?? 'poll',
          cyclesScreened: diagnostics.cyclesScreened,
          trianglesEnumerated: diagnostics.trianglesEnumerated,
          cyclesConfirmed: diagnostics.cyclesConfirmed,
          cyclesUnprofitable: diagnostics.cyclesUnprofitable,
          quotesImplausible: diagnostics.quotesImplausible,
          quotesFetched: diagnostics.quotesFetched,
          quotesReused: diagnostics.quotesReused,
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

        // Deliberately not alerted. An alert fires only once a trade has actually
        // been settled and has a realised P&L attached, so the Telegram stream
        // stays a record of results rather than a feed of intentions. Detection
        // is a log-level event.

        // In paper mode the candidate is already queued for honest settlement, so
        // there is nothing more to do here. Falling through to the executor would
        // be harmless — it refuses to send outside live mode — but it would log a
        // misleading "not executed" line for a trade that is being measured.
        if (this.config.mode === 'paper') continue;

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
    } finally {
      // Must be cleared on every path, including the early returns above. Leaving
      // it set would permanently wedge the chain: every future block trigger and
      // every safety-net tick would see a scan "in progress" and skip.
      runtime.scanning = false;
    }
  }

  // ── paper settlement ──────────────────────────────────────────────────────

  /**
   * Re-price every due candidate against current state and book the result.
   *
   * This is where the honesty lives. The detected profit is treated purely as a
   * prediction; the number recorded comes from re-quoting the same route at the
   * same size now, with gas at the current price. Anything that no longer clears
   * cost is booked as a loss of exactly the gas — which is what a live attempt
   * would have cost, since the contract reverts rather than completing a losing
   * trade.
   */
  private async settlePaperTrades(
    runtime: ChainRuntime,
    scanCtx: Parameters<typeof requoteCycle>[0],
  ): Promise<void> {
    const due = this.paper.due(runtime.name);
    if (due.length === 0) return;

    const nativeUsd = runtime.oracle.nativeUsd();

    for (const entry of due) {
      if (this.stopping) return;
      try {
        await this.settleOne(entry, runtime, scanCtx, nativeUsd);
      } catch (err) {
        log.warn('paper settlement failed', { route: entry.route, ...errMeta(err) });
        // Book it rather than leaking the pending entry; an unquotable route is
        // a real outcome, and silently dropping it would bias the fill rate up.
        await this.paper.settle(entry, {
          actualGrossUsd: 0,
          gasCostUsd: gasCostUsd(
            estimateRouteGas(entry.legs, !!runtime.ctx.chain.balancerVault),
            runtime.lastGasPriceWei,
            nativeUsd,
          ),
          quoted: false,
        });
      }
    }
  }

  private async settleOne(
    entry: PendingPaperTrade,
    runtime: ChainRuntime,
    scanCtx: Parameters<typeof requoteCycle>[0],
    nativeUsd: number,
  ): Promise<void> {
    const baseToken = entry.legs[0]?.tokenIn;
    const gasUsd = gasCostUsd(
      estimateRouteGas(entry.legs, !!runtime.ctx.chain.balancerVault),
      runtime.lastGasPriceWei,
      nativeUsd,
    );

    if (!baseToken) {
      await this.paper.settle(entry, { actualGrossUsd: 0, gasCostUsd: gasUsd, quoted: false });
      return;
    }

    const { amountOut, quoted } = await requoteCycle(scanCtx, entry.legs, entry.amountIn);

    let actualGrossUsd = 0;
    if (quoted) {
      // Repay the loan and its premium out of the proceeds; whatever remains is
      // the realised edge. Signed, because the re-quote can come back worse than
      // the borrow and that must be recorded as such.
      const owed = entry.amountIn + flashFee(entry.amountIn, this.paperFlashFeeBps(runtime));
      const profit = amountOut - owed;
      const basePrice = runtime.oracle.usd(baseToken);
      actualGrossUsd = basePrice > 0 ? valueUsd(profit, baseToken, basePrice) : 0;
    }

    const trade = await this.paper.settle(entry, {
      actualGrossUsd,
      gasCostUsd: gasUsd,
      quoted,
    });

    const level = trade.outcome === 'filled' ? 'info' : 'debug';
    const payload = {
      chain: trade.chain,
      route: trade.route,
      token: trade.tokenPath,
      outcome: trade.outcome,
      notionalUsd: trade.notionalUsd,
      expectedNetUsd: trade.expectedNetUsd,
      actualNetUsd: trade.actualNetUsd,
      pnlPct: trade.pnlPct,
      capitalBeforeUsd: trade.capitalBeforeUsd,
      capitalAfterUsd: trade.capitalAfterUsd,
      decayBps: trade.decayBps,
      heldMs: trade.settleDelayMs,
      wouldExecuteLive: trade.wouldExecuteLive,
    };
    if (level === 'info') log.info('paper trade settled', payload);
    else log.debug('paper trade settled', payload);

    // Skipped candidates never become trades — no transaction would have been
    // broadcast — so alerting them as if a trade occurred produces a stream of
    // $0.00 "PROFIT" messages that looks like the bot is broken.
    if (trade.outcome !== 'skipped') {
      await this.notifier.paperTrade(trade);
    }

    if (!this.paper.solvent && !this.paperInsolvencyReported) {
      this.paperInsolvencyReported = true;
      log.error('paper account insolvent — no further candidates will be opened', {
        capitalUsd: trade.capitalAfterUsd,
      });
      await this.notifier.halted(
        `paper capital exhausted at $${trade.capitalAfterUsd.toFixed(2)}`,
      );
    }
  }

  /** Flash premium the settled route would have paid. Balancer is free; Aave is not. */
  private paperFlashFeeBps(runtime: ChainRuntime): number {
    return runtime.ctx.chain.balancerVault ? BALANCER_FLASH_FEE_BPS : AAVE_FLASH_FEE_BPS;
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
        // Not alerted. Engine B never executes, so a CEX spread has no realised
        // P&L to report; pushing it to Telegram would dilute a stream whose value
        // depends on every message being a completed trade.
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
        solidlyPools: runtime.pools.solidly.length,
        curvePools: runtime.pools.curve.length,
        scanTrigger: runtime.trigger ?? 'poll',
        lastScanBlock: runtime.lastScanBlock ?? null,
        poolActivity: runtime.activity?.stats() ?? null,
        screenCached: runtime.screenCache.size,
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

    // Close block subscriptions explicitly: an open WebSocket keeps the event
    // loop alive and the process would not exit on SIGTERM.
    for (const runtime of this.runtimes) {
      runtime.blockWatcher?.stop();
      runtime.blockWatcher = undefined;
      runtime.activity?.stop();
      runtime.activity = undefined;
    }

    // Persist the in-flight rollup window. Railway redeploys are routine, and
    // losing the market record on every restart would leave gaps precisely when
    // a long-running measurement needs continuity.
    if (this.config.mode === 'paper') {
      try {
        await this.paper.flushMarketSamples();
        log.info('final paper summary', { ...this.paper.stats() });
      } catch (err) {
        log.warn('could not flush paper ledger on shutdown', errMeta(err));
      }
    }

    await this.cexFeeds?.close();
    this.cexDexEngine?.stop();

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
