/**
 * SCANETH ATH / PNL tracker.
 *
 * For every token that triggers an initial alert, this module polls
 * DEXScreener and sends a follow-up Telegram alert the first time the token
 * reaches a new all-time-high for the current UTC day.
 */

import { createLogger, errMeta } from '../logger';
import type { ScanethConfig } from '../config';
import type { TokenLaunch } from './types';
import type { ScanethNotifier } from './notifier';
import { fetchTokenPairs, pickBestPair } from './dexscreener';

const log = createLogger('scaneth:tracker');

export interface TrackedToken {
  tokenAddress: string;
  name: string;
  symbol: string;
  /** Price in USD at the moment the initial alert was sent. */
  entryPriceUsd: number;
  /** Block number where the launch was detected. */
  blockNumber: number;
  /** Timestamp when the initial alert was sent. */
  alertedAt: number;
  /** Highest price observed today (UTC). */
  dailyAthUsd: number;
  /** Whether the ATH alert has already been sent today. */
  athAlertSent: boolean;
  /** Day string YYYY-MM-DD for which dailyAthUsd is tracked. */
  trackingDay: string;
}

export class AthTracker {
  private readonly tracked = new Map<string, TrackedToken>();
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ScanethConfig,
    private readonly notifier: ScanethNotifier,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('ATH tracker started', { intervalMs: this.config.athPollIntervalMs });
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Called by the scanner whenever an initial alert is emitted. */
  trackAlert(launch: TokenLaunch): void {
    const pair = launch.dexScreener?.pair;
    if (!pair || !pair.priceUsd) {
      log.debug('no price on alert, skipping tracking', { address: launch.tokenAddress });
      return;
    }

    const entryPrice = Number(pair.priceUsd);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      log.debug('invalid entry price, skipping tracking', { address: launch.tokenAddress, entryPrice });
      return;
    }

    const day = currentUtcDay();
    const tracked: TrackedToken = {
      tokenAddress: launch.tokenAddress,
      name: launch.metadata.name,
      symbol: launch.metadata.symbol,
      entryPriceUsd: entryPrice,
      blockNumber: launch.blockNumber,
      alertedAt: Date.now(),
      dailyAthUsd: entryPrice,
      athAlertSent: false,
      trackingDay: day,
    };

    this.tracked.set(launch.tokenAddress.toLowerCase(), tracked);
    log.info('now tracking token for ATH', {
      address: tracked.tokenAddress,
      symbol: tracked.symbol,
      entryPrice: tracked.entryPriceUsd,
    });
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.pollAll();
    } catch (err) {
      log.error('ATH tracker tick failed', errMeta(err));
    }

    this.timer = setTimeout(() => void this.tick(), this.config.athPollIntervalMs);
  }

  private async pollAll(): Promise<void> {
    const today = currentUtcDay();

    for (const [key, token] of this.tracked) {
      // Reset ATH tracking if the day rolled over.
      if (token.trackingDay !== today) {
        token.trackingDay = today;
        token.dailyAthUsd = token.entryPriceUsd;
        token.athAlertSent = false;
      }

      if (token.athAlertSent) continue;

      try {
        const pairs = await fetchTokenPairs(token.tokenAddress);
        const best = pickBestPair(pairs, token.tokenAddress);
        if (!best?.priceUsd) continue;

        const currentPrice = Number(best.priceUsd);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

        if (currentPrice > token.dailyAthUsd) {
          token.dailyAthUsd = currentPrice;
          await this.sendAthAlert(token);
          token.athAlertSent = true;
        }
      } catch (err) {
        log.debug('price poll failed', { address: token.tokenAddress, ...errMeta(err) });
      }
    }

    // Prune tokens older than 48h to avoid unbounded growth.
    const cutoff = Date.now() - 48 * 3_600_000;
    for (const [key, token] of this.tracked) {
      if (token.alertedAt < cutoff) this.tracked.delete(key);
    }
  }

  private async sendAthAlert(token: TrackedToken): Promise<void> {
    const pnlPct = ((token.dailyAthUsd - token.entryPriceUsd) / token.entryPriceUsd) * 100;
    const sign = pnlPct >= 0 ? '+' : '';

    const message =
      `<b>SCANETH — ATH update</b>\n\n` +
      `<b>${escapeHtml(token.name)} (${escapeHtml(token.symbol)})</b>\n` +
      `Address: <code>${token.tokenAddress}</code>\n\n` +
      `<b>Entry price</b> (at initial alert)\n` +
      `$${formatPrice(token.entryPriceUsd)}\n\n` +
      `<b>Daily ATH</b>\n` +
      `$${formatPrice(token.dailyAthUsd)}\n\n` +
      `<b>Unrealized PNL</b>\n` +
      `<b>${sign}${pnlPct.toFixed(2)}%</b>\n\n` +
      `<a href="https://etherscan.io/token/${token.tokenAddress}">Etherscan</a> · ` +
      `<a href="https://dexscreener.com/ethereum/${token.tokenAddress}">DEXScreener</a>`;

    const ok = await this.notifier.sendRaw(message);
    if (ok) {
      log.info('ATH alert sent', {
        address: token.tokenAddress,
        symbol: token.symbol,
        entry: token.entryPriceUsd,
        ath: token.dailyAthUsd,
        pnlPct,
      });
    }
  }
}

function currentUtcDay(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function formatPrice(n: number): string {
  if (n === 0) return '0';
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toExponential(4);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
