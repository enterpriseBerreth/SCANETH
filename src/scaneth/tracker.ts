/**
 * SCANETH ATH / PNL tracker and daily winners report.
 *
 * For every token that triggers an initial alert, this module polls
 * DEXScreener and optionally sends:
 *   1. A follow-up Telegram alert the first time the token reaches a new
 *      all-time-high for the current MST day (if ATH_TRACKER_ENABLED=true).
 *   2. A daily 12:00am MST report of the top 5 winners from the previous day
 *      with their ATH and unrealized PNL (if DAILY_REPORT_ENABLED=true).
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
  /** Highest price observed today (MST). */
  dailyAthUsd: number;
  /** Whether the ATH alert has already been sent today. */
  athAlertSent: boolean;
  /** Day string YYYY-MM-DD for which dailyAthUsd is tracked. */
  trackingDay: string;
}

export class AthTracker {
  private readonly tracked = new Map<string, TrackedToken>();
  private priceTimer?: NodeJS.Timeout;
  private reportTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ScanethConfig,
    private readonly notifier: ScanethNotifier,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.config.athTrackerEnabled) {
      log.info('ATH tracker started', { intervalMs: this.config.athPollIntervalMs });
    }
    if (this.config.dailyReportEnabled) {
      log.info('daily winners report scheduled', { hourUtc: this.config.dailyReportHourUtc });
      this.scheduleDailyReport();
    }

    if (this.config.athTrackerEnabled || this.config.dailyReportEnabled) {
      void this.priceTick();
    }
  }

  stop(): void {
    this.running = false;
    if (this.priceTimer) clearTimeout(this.priceTimer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
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

    const day = currentMstDay();
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
    log.info('now tracking token for PNL', {
      address: tracked.tokenAddress,
      symbol: tracked.symbol,
      entryPrice: tracked.entryPriceUsd,
    });
  }

  private async priceTick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.pollAll();
    } catch (err) {
      log.error('ATH tracker tick failed', errMeta(err));
    }

    this.priceTimer = setTimeout(() => void this.priceTick(), this.config.athPollIntervalMs);
  }

  private scheduleDailyReport(): void {
    if (!this.running) return;
    const next = nextUtcOccurrence(this.config.dailyReportHourUtc, 0);
    const msUntil = next.getTime() - Date.now();
    log.debug('next daily report scheduled', { at: next.toISOString(), msUntil });
    this.reportTimer = setTimeout(() => {
      void this.sendDailyReport();
      this.scheduleDailyReport();
    }, Math.max(1_000, msUntil));
  }

  private async pollAll(): Promise<void> {
    const today = currentMstDay();

    for (const [key, token] of this.tracked) {
      // Reset ATH tracking if the MST day rolled over.
      if (token.trackingDay !== today) {
        token.trackingDay = today;
        token.dailyAthUsd = token.entryPriceUsd;
        token.athAlertSent = false;
      }

      try {
        const pairs = await fetchTokenPairs(token.tokenAddress);
        const best = pickBestPair(pairs, token.tokenAddress);
        if (!best?.priceUsd) continue;

        const currentPrice = Number(best.priceUsd);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;

        if (currentPrice > token.dailyAthUsd) {
          token.dailyAthUsd = currentPrice;
        }

        if (this.config.athTrackerEnabled && !token.athAlertSent && currentPrice > token.entryPriceUsd) {
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

  private async sendDailyReport(): Promise<void> {
    if (!this.config.dailyReportEnabled) return;

    const previousDay = previousMstDay(this.config.dailyReportHourUtc);
    const candidates: Array<{ token: TrackedToken; athPnlPct: number }> = [];

    for (const token of this.tracked.values()) {
      // Include tokens alerted during the previous MST day, or any tracked token
      // whose MST tracking day matches the previous day.
      if (token.trackingDay !== previousDay && !isAlertedOnDay(token.alertedAt, previousDay, this.config.dailyReportHourUtc)) {
        continue;
      }
      if (!Number.isFinite(token.dailyAthUsd) || token.dailyAthUsd <= 0) continue;
      const athPnlPct = ((token.dailyAthUsd - token.entryPriceUsd) / token.entryPriceUsd) * 100;
      candidates.push({ token, athPnlPct });
    }

    candidates.sort((a, b) => b.athPnlPct - a.athPnlPct);
    const top5 = candidates.slice(0, 5);

    if (top5.length === 0) {
      const message =
        `<b>SCANETH — Daily winners report</b>\n\n` +
        `No tracked tokens from ${previousDay} reached a new high. Better luck today!`;
      await this.notifier.sendRaw(message);
      log.info('daily winners report sent', { previousDay, winners: 0 });
      return;
    }

    const lines = top5.map((item, idx) => {
      const { token, athPnlPct } = item;
      const sign = athPnlPct >= 0 ? '+' : '';
      return (
        `${idx + 1}. <b>${escapeHtml(token.name)} (${escapeHtml(token.symbol)})</b>\n` +
        `   Address: <code>${token.tokenAddress}</code>\n` +
        `   Entry: $${formatPrice(token.entryPriceUsd)} → ATH: $${formatPrice(token.dailyAthUsd)}\n` +
        `   PNL: <b>${sign}${athPnlPct.toFixed(2)}%</b>`
      );
    });

    const message =
      `<b>SCANETH — Daily winners report (${previousDay})</b>\n\n` +
      lines.join('\n\n');

    const ok = await this.notifier.sendRaw(message);
    if (ok) {
      log.info('daily winners report sent', { previousDay, winners: top5.length });
    }
  }
}

/** Current MST day string YYYY-MM-DD. MST = UTC-7. */
function currentMstDay(): string {
  return dayStringAtOffset(-7);
}

function previousMstDay(reportHourUtc: number): string {
  const now = new Date();
  // Previous report time in UTC.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), reportHourUtc, 0, 0, 0));
  if (prev.getTime() >= now.getTime()) {
    prev.setUTCDate(prev.getUTCDate() - 1);
  }
  // Convert to MST.
  const mst = new Date(prev.getTime() - 7 * 3_600_000);
  return `${mst.getUTCFullYear()}-${String(mst.getUTCMonth() + 1).padStart(2, '0')}-${String(mst.getUTCDate()).padStart(2, '0')}`;
}

function isAlertedOnDay(timestampMs: number, dayString: string, reportHourUtc: number): boolean {
  const d = new Date(timestampMs);
  // Convert alert timestamp to MST.
  const mst = new Date(d.getTime() - 7 * 3_600_000);
  const alertDay = `${mst.getUTCFullYear()}-${String(mst.getUTCMonth() + 1).padStart(2, '0')}-${String(mst.getUTCDate()).padStart(2, '0')}`;
  return alertDay === dayString;
}

function dayStringAtOffset(offsetHours: number): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetHours * 3_600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/** Returns the next UTC Date at the given hour/minute. */
function nextUtcOccurrence(hourUtc: number, minuteUtc: number): Date {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
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
