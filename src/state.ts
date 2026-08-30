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
  contractsCreated = 0;
  tokensIdentified = 0;
  launchesDetected = 0;
  alertsSent = 0;
  lastBlockNumber = 0;
  lastBlockAt = 0;
  lastError?: string;

  readonly recentLaunches: TokenLaunch[] = [];
  readonly recentAlerts: TokenLaunch[] = [];

  updateFromStats(stats: ScanStats): void {
    this.blocksProcessed = stats.blocksProcessed;
    this.contractsCreated = stats.contractsCreated;
    this.tokensIdentified = stats.tokensIdentified;
    this.launchesDetected = stats.launchesDetected;
    this.alertsSent = stats.alertsSent;
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
      contractsCreated: this.contractsCreated,
      tokensIdentified: this.tokensIdentified,
      launchesDetected: this.launchesDetected,
      alertsSent: this.alertsSent,
      lastError: this.lastError ?? null,
      recentAlerts: this.recentAlerts.slice(0, 10).map((a) => ({
        name: a.metadata.name,
        symbol: a.metadata.symbol,
        score: a.risk.score,
        tier: a.risk.tier,
        block: a.blockNumber,
        token: a.tokenAddress,
        at: new Date(a.discoveredAt).toISOString(),
      })),
    };
  }
}
