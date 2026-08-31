/**
 * SCANETH run state.
 *
 * In-memory counters and recent launch log. A restarted scanner should not
 * trust stale local state; it resumes from the chain head.
 */

import type { ScanStats, TokenLaunch } from './scaneth/types';

const MAX_LOG = 100;

export class BotState {
  readonly startedAt = Date.now();

  blocksProcessed = 0;
  pairsDetected = 0;
  tokensIdentified = 0;
  launchesDetected = 0;
  alertsSent = 0;
  dexScreenerHits = 0;
  dexScreenerMisses = 0;
  lastBlockNumber = 0;
  lastBlockAt = 0;
  lastError?: string;

  readonly recentLaunches: TokenLaunch[] = [];
  readonly recentAlerts: TokenLaunch[] = [];

  updateFromStats(stats: ScanStats): void {
    this.blocksProcessed = stats.blocksProcessed;
    this.pairsDetected = stats.pairsDetected;
    this.tokensIdentified = stats.tokensIdentified;
    this.launchesDetected = stats.launchesDetected;
    this.alertsSent = stats.alertsSent;
    this.dexScreenerHits = stats.dexScreenerHits;
    this.dexScreenerMisses = stats.dexScreenerMisses;
    this.lastBlockNumber = stats.lastBlockNumber;
    this.lastBlockAt = stats.lastBlockAt;
  }

  recordLaunch(launch: TokenLaunch): void {
    this.recentLaunches.unshift(launch);
    if (this.recentLaunches.length > MAX_LOG) this.recentLaunches.pop();
  }

  recordAlert(alert: TokenLaunch): void {
    this.recentAlerts.unshift(alert);
    if (this.recentAlerts.length > MAX_LOG) this.recentAlerts.pop();
  }

  snapshot(): Record<string, unknown> {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      blocksProcessed: this.blocksProcessed,
      lastBlockNumber: this.lastBlockNumber,
      lastBlockAt: this.lastBlockAt ? new Date(this.lastBlockAt).toISOString() : null,
      pairsDetected: this.pairsDetected,
      tokensIdentified: this.tokensIdentified,
      launchesDetected: this.launchesDetected,
      alertsSent: this.alertsSent,
      dexScreenerHits: this.dexScreenerHits,
      dexScreenerMisses: this.dexScreenerMisses,
      lastError: this.lastError ?? null,
      recentAlerts: this.recentAlerts.slice(0, 10).map((a) => ({
        name: a.metadata.name,
        symbol: a.metadata.symbol,
        score: a.risk.score,
        tier: a.risk.tier,
        safetyScore: a.safety.score,
        sellable: a.safety.sellable,
        ageHours: a.dexScreener ? (a.dexScreener.ageMs / 3_600_000).toFixed(2) : null,
        h1Txns: a.dexScreener?.h1Txns,
        h1Sells: a.dexScreener?.h1Sells,
        block: a.blockNumber,
        token: a.tokenAddress,
        at: new Date(a.discoveredAt).toISOString(),
      })),
    };
  }
}
