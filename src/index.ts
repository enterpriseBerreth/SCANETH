/**
 * SCANETH entry point.
 *
 * Wires the Ethereum block scanner, DEXScreener enrichment, Telegram notifier
 * and HTTP server together. The bot streams every new Ethereum block, detects
 * new DEX pairs, and sends a Telegram alert for every newly-paired token with
 * complete metadata. Each alert includes the token name, exact address, scam
 * rating, and a pros/cons summary.
 */

import { loadConfig, type ScanethConfig } from './config';
import { createLogger, errMeta } from './logger';
import { BotState } from './state';
import { startServer } from './server';
import { ScanethNotifier } from './scaneth/notifier';
import { BlockScanner } from './scaneth/scanner';
import { createProviders, destroyProviders, type ProviderPair } from './scaneth/provider';
import { AthTracker } from './scaneth/tracker';
import type { TokenLaunch } from './scaneth/types';
import type { Server } from 'node:http';

const log = createLogger('scaneth');

class ScanethBot {
  private readonly state = new BotState();
  private readonly notifier: ScanethNotifier;
  private readonly tracker: AthTracker;
  private providers?: ProviderPair;
  private scanner?: BlockScanner;
  private httpServer?: Server;
  private stopping = false;
  private pollTimer?: NodeJS.Timeout;

  constructor(private readonly config: ScanethConfig) {
    this.notifier = new ScanethNotifier(config);
    this.tracker = new AthTracker(config, this.notifier);
  }

  async start(): Promise<void> {
    this.banner();

    this.httpServer = startServer({
      config: this.config,
      state: this.state,
      recentAlerts: () => this.state.recentAlerts,
    });

    this.providers = createProviders(this.config.rpcUrl, this.config.wsUrl);
    this.scanner = new BlockScanner(this.providers.http, {
      probeEth: this.config.probeEth,
      maxTaxBps: this.config.maxTaxBps,
      maxTopHolderPct: this.config.maxTopHolderPct,
    });

    const network = await this.providers.http.getNetwork();
    log.info('connected', { chainId: network.chainId, name: network.name });

    if (this.config.telegramTestOnBoot) {
      const ok = await this.notifier.test();
      log.info(ok ? 'telegram test delivered' : 'telegram test failed');
    }

    if (this.config.athTrackerEnabled || this.config.dailyReportEnabled) {
      this.tracker.start();
    }

    if (this.config.backtest) {
      log.info('backtest mode', { from: this.config.backtest.from, to: this.config.backtest.to });
      const result = await this.scanner.scanRange(this.config.backtest.from, this.config.backtest.to);
      await this.handleResult(result);
      await this.shutdown();
      return;
    }

    const startBlock = this.config.startBlock ?? (await this.providers.http.getBlockNumber());
    log.info('starting scanner', { startBlock, ws: !!this.config.wsUrl });

    if (this.config.wsUrl && this.providers.main.on) {
      this.providers.main.on('block', (blockNumber: number) => {
        if (this.stopping) return;
        void this.processBlock(blockNumber);
      });
    } else {
      this.schedulePoll(startBlock);
    }
  }

  private banner(): void {
    log.info('SCANETH starting', {
      rpcUrl: this.config.rpcUrl.replace(/\/\/.*@/, '//***@'),
      filters: {
        probeEth: this.config.probeEth,
        maxTaxBps: this.config.maxTaxBps,
        maxTopHolderPct: this.config.maxTopHolderPct,
      },
      athTracker: this.config.athTrackerEnabled ? 'enabled' : 'disabled',
      dailyReport: this.config.dailyReportEnabled ? 'enabled' : 'disabled',
      telegram: this.notifier.isEnabled ? 'enabled' : 'disabled',
    });
    log.info('research-only scanner — no transactions are ever sent');
  }

  private schedulePoll(expectedBlock: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(async () => {
      try {
        const latest = await this.providers!.http.getBlockNumber();
        const target = Math.max(expectedBlock, latest);
        await this.processBlock(target);
      } catch (err) {
        log.error('poll failed', errMeta(err));
      }
      this.schedulePoll(expectedBlock + 1);
    }, this.config.pollIntervalMs);
  }

  private async processBlock(blockNumber: number): Promise<void> {
    if (!this.scanner) return;
    const result = await this.scanner.processBlock(blockNumber);
    await this.handleResult(result);
  }

  private async handleResult(result: import('./scaneth/scanner').ScanResult): Promise<void> {
    this.state.updateFromStats(result.stats);

    for (const launch of result.launches) {
      this.state.recordLaunch(launch);
    }

    for (const alert of result.alerts) {
      this.state.recordAlert(alert);
      log.info('active new launch alert', {
        name: alert.metadata.name,
        symbol: alert.metadata.symbol,
        ageHours: alert.dexScreener ? (alert.dexScreener.ageMs / 3_600_000).toFixed(2) : null,
        h1Txns: alert.dexScreener?.h1Txns,
        h1Sells: alert.dexScreener?.h1Sells,
        block: alert.blockNumber,
      });
      if (this.notifier.isEnabled) {
        await this.notifier.alertLaunch(alert);
      }
      if (this.config.athTrackerEnabled || this.config.dailyReportEnabled) {
        this.tracker.trackAlert(alert);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info('shutting down', this.state.snapshot());

    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.tracker.stop();

    if (this.providers) {
      destroyProviders(this.providers);
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = undefined;
    }
  }
}

async function main(): Promise<void> {
  let config: ScanethConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`\nSCANETH configuration error:\n${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }

  const bot = new ScanethBot(config);

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
