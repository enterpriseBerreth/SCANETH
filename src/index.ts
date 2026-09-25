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
  /** Blocks already processed (by either WS stream or poll loop) — dedup guard. */
  private readonly processedBlocks = new Set<number>();

  constructor(private readonly config: ScanethConfig) {
    this.notifier = new ScanethNotifier(config);
  }

  async start(): Promise<void> {
    this.banner();

    this.httpServer = startServer({
      config: this.config,
      state: this.state,
      recentAlerts: () => this.state.recentAlerts,
      copytraderStats: () => this.copytrader?.getStats(),
      scoutStats: () => this.walletScout?.getStats(),
      positions: () => this.copytrader?.getOpenPositions() ?? [],
    });

    this.providers = createProviders(this.config.rpcUrl, this.config.wsUrl);
    this.scanner = new BlockScanner(this.providers.http, {
      probeEth: this.config.probeEth,
      maxTaxBps: this.config.maxTaxBps,
      maxTopHolderPct: this.config.maxTopHolderPct,
    });
    this.copytrader = new CopyTrader(this.config, this.providers.http, this.notifier);

    const network = await this.providers.http.getNetwork();
    log.info('connected', { chainId: network.chainId, name: network.name });

    if (this.config.copytraderEnabled) {
      this.copytrader.start();
      this.walletScout = new WalletScout(this.config, this.providers.http, this.notifier, this.copytrader);
      this.walletScout.start();
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
    }
    // Poll loop always runs as a safety net: it catches blocks missed during
    // WebSocket drops (ethers auto-reconnects, but events can be lost) and
    // corrects any lag. processBlock dedups, so overlap is harmless.
    this.schedulePoll(startBlock);
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
    log.info('research-only scanner — no transactions are ever sent');
  }

  private schedulePoll(expectedBlock: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(async () => {
      let next = expectedBlock + 1;
      try {
        const latest = await this.providers!.http.getBlockNumber();
        // If we've fallen too far behind, jump to the chain head. Grinding
        // through old blocks is both slow and rejected by free RPCs (archive
        // gating), which would leave the scanner permanently stuck.
        const lag = latest - expectedBlock;
        if (lag > 15) {
          log.warn('scanner too far behind — jumping to chain head', {
            expectedBlock,
            latest,
            skipped: lag,
          });
          next = latest;
        } else {
          const end = Math.min(latest, expectedBlock + 30);
          for (let b = expectedBlock; b <= end; b++) {
            if (this.stopping) return;
            await this.processBlock(b);
          }
          next = end + 1;
        }
      } catch (err) {
        log.error('poll failed', errMeta(err));
      }
      this.schedulePoll(next);
    }, this.config.pollIntervalMs);
  }

  private async processBlock(blockNumber: number): Promise<void> {
    if (!this.scanner) return;
    if (this.processedBlocks.has(blockNumber)) return;
    this.processedBlocks.add(blockNumber);
    // Keep the dedup set bounded: a 12s block cadence means ~7,200 entries/day.
    if (this.processedBlocks.size > 2_000) {
      const excess = this.processedBlocks.size - 1_000;
      let removed = 0;
      for (const b of this.processedBlocks) {
        this.processedBlocks.delete(b);
        if (++removed >= excess) break;
      }
    }
    const result = await this.scanner.processBlock(blockNumber);
    await this.handleResult(result);
    if (this.copytrader) {
      await this.copytrader.processBlock(blockNumber);
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
