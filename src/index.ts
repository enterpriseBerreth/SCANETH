/**
 * SCANETH entry point.
 *
 * Pure copywallet bot: streams every new Ethereum block, mirrors the buys and
 * sells of watched wallets into a paper-trading account ($20 per buy,
 * proportional exits), and Telegrams one alert per closed trade plus the
 * daily midnight MST wallet ranking. An auto-scout engine periodically swaps
 * losing wallets for newly discovered profitable ones.
 */

import { loadConfig, type ScanethConfig } from './config';
import { createLogger, errMeta } from './logger';
import { BotState } from './state';
import { startServer } from './server';
import { ScanethNotifier } from './scaneth/notifier';
import { BlockScanner } from './scaneth/scanner';
import { createProviders, destroyProviders, type ProviderPair } from './scaneth/provider';
import { CopyTrader } from './scaneth/copytrader';
import { WalletScout } from './scaneth/wallet-scout';
import { WebSocketProvider } from 'ethers';
import type { Server } from 'node:http';

const log = createLogger('scaneth');

class ScanethBot {
  private readonly state = new BotState();
  private readonly notifier: ScanethNotifier;
  private providers?: ProviderPair;
  private scanner?: BlockScanner;
  private copytrader?: CopyTrader;
  private walletScout?: WalletScout;
  private httpServer?: Server;
  private stopping = false;
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private lastProcessedBlock = 0;

  constructor(private readonly config: ScanethConfig) {
    this.notifier = new ScanethNotifier(config);
  }

  async start(): Promise<void> {
    this.banner();

    this.providers = createProviders(this.config.rpcUrl, this.config.wsUrl);
    this.copytrader = new CopyTrader(this.config, this.providers.http, this.notifier);

    const network = await this.providers.http.getNetwork();
    log.info('connected', { chainId: network.chainId, name: network.name });

    if (this.config.copytraderEnabled) {
      await this.copytrader.start();
      this.walletScout = new WalletScout(this.config, this.providers.http, this.notifier, this.copytrader);
      this.walletScout.start();
    }

    if (this.config.backtest) {
      this.scanner = new BlockScanner(this.providers.http, {
        probeEth: this.config.probeEth,
        maxTaxBps: this.config.maxTaxBps,
        maxTopHolderPct: this.config.maxTopHolderPct,
      });
      log.info('backtest mode', { from: this.config.backtest.from, to: this.config.backtest.to });
      const result = await this.scanner.scanRange(this.config.backtest.from, this.config.backtest.to);
      await this.handleResult(result);
      await this.shutdown();
      return;
    }

    this.httpServer = startServer({
      config: this.config,
      state: this.state,
      recentAlerts: () => this.state.recentAlerts,
      copytrader: this.copytrader,
      copytraderStats: () => this.copytrader?.getStats(),
      scoutStats: () => this.walletScout?.getStats(),
      positions: () => this.copytrader?.getOpenPositions() ?? [],
    });

    const startBlock = this.config.startBlock ?? (await this.providers.http.getBlockNumber());
    this.lastProcessedBlock = startBlock - 1;
    log.info('starting copywallet monitor', { startBlock, ws: !!this.config.wsUrl });

    if (this.config.wsUrl && this.providers.main.on) {
      this.providers.main.on('block', (blockNumber: number) => {
        if (!this.stopping) void this.processThrough(blockNumber);
      });
    }
    this.schedulePoll();
  }

  private banner(): void {
    log.info('SCANETH starting', {
      rpcUrl: this.config.rpcUrl.replace(/\/\/.*@/, '//***@'),
      filters: {
        probeEth: this.config.probeEth,
        maxTaxBps: this.config.maxTaxBps,
        maxTopHolderPct: this.config.maxTopHolderPct,
      },
      athTracker: 'disabled (copywallet bot)',
      dailyReport: this.config.dailyReportEnabled ? 'enabled' : 'disabled',
      copytrader: this.config.copytraderEnabled ? 'enabled' : 'disabled',
      telegram: this.notifier.isEnabled ? 'enabled' : 'disabled',
    });
    log.info('paper-only copywallet monitor — no transactions are sent');
  }

  private schedulePoll(): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(async () => {
      try {
        const latest = await this.providers!.http.getBlockNumber();
        await this.processThrough(latest);
      } catch (err) {
        log.error('poll failed', errMeta(err));
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  private async processThrough(latest: number): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      if (latest - this.lastProcessedBlock > 15) {
        log.warn('copywallet monitor lag exceeds 15 blocks — catching up', {
          nextBlock: this.lastProcessedBlock + 1,
          latest,
        });
      }
      for (let blockNumber = this.lastProcessedBlock + 1; blockNumber <= latest; blockNumber++) {
        if (this.stopping) break;
        if (this.config.copytraderEnabled && !(await this.copytrader!.processBlock(blockNumber))) {
          this.state.lastError = `copywallet block ${blockNumber} could not be processed; retrying`;
          break;
        }
        this.lastProcessedBlock = blockNumber;
        this.state.lastError = undefined;
        this.state.recordBlock(blockNumber);
      }
    } catch (err) {
      this.state.lastError = err instanceof Error ? err.message : String(err);
      log.error('copywallet monitor failed', errMeta(err));
    } finally {
      this.polling = false;
    }
  }

  private async handleResult(result: import('./scaneth/scanner').ScanResult): Promise<void> {
    this.state.updateFromStats(result.stats);

    for (const launch of result.launches) {
      this.state.recordLaunch(launch);
    }
    // Launch alerts removed — SCANETH is a pure copywallet bot now.
    // Scanner metrics (launches/alerts counters) are still tracked above.
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info('shutting down', this.state.snapshot());

    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.scanner?.stop();
    this.copytrader?.stop();
    this.walletScout?.stop();
    await this.copytrader?.persistState();

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

void main().catch((err) => {
  log.error('startup failed', errMeta(err));
  process.exit(1);
});
