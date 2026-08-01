/**
 * Risk engine.
 *
 * A profitable strategy with no risk limits is still ruinous, because the
 * failure modes of an arbitrage bot are correlated: a bad RPC, a stale price
 * feed or a mispriced pool will not fail once, it will fail on every scan until
 * the capital is gone. So the limits here are about bounding *repeated* loss,
 * not individual trade sizing.
 */

import type { ArboConfig } from './config';
import type { ArbOpportunity } from './types';
import type { BotState } from './state';

export type RiskVerdict = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: RiskVerdict = { allowed: true };

function deny(reason: string): RiskVerdict {
  return { allowed: false, reason };
}

/**
 * Gate applied immediately before execution.
 * Ordered cheapest-check-first so the common rejection paths are free.
 */
export function assessRisk(
  config: ArboConfig,
  state: BotState,
  opportunity: ArbOpportunity,
): RiskVerdict {
  if (config.killSwitch) {
    return deny('kill switch engaged');
  }

  if (state.lossToday >= config.maxDailyLossUsd) {
    return deny(
      `daily loss limit reached ($${state.lossToday.toFixed(2)} >= $${config.maxDailyLossUsd})`,
    );
  }

  if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
    return deny(
      `halted after ${state.consecutiveFailures} consecutive failures — investigate before resuming`,
    );
  }

  // Back off briefly after a failure so a systemic problem cannot be retried
  // dozens of times per minute.
  const sinceFailure = Date.now() - state.lastFailureAt;
  if (state.lastFailureAt > 0 && sinceFailure < config.failureCooldownMs) {
    const waitMs = config.failureCooldownMs - sinceFailure;
    return deny(`cooling down for ${Math.ceil(waitMs / 1000)}s after a failure`);
  }

  if (opportunity.notionalUsd > config.maxTradeUsd) {
    return deny(
      `notional $${opportunity.notionalUsd.toFixed(0)} exceeds cap $${config.maxTradeUsd}`,
    );
  }

  if (opportunity.netProfitUsd < config.minProfitUsd) {
    return deny(
      `net $${opportunity.netProfitUsd.toFixed(2)} below floor $${config.minProfitUsd}`,
    );
  }

  // Gas exceeding gross profit means the "opportunity" is a loss dressed up as
  // a spread. Should already be filtered upstream; treated as a hard stop here.
  if (opportunity.gasCostUsd >= opportunity.grossProfitUsd) {
    return deny('gas cost exceeds gross profit');
  }

  return ALLOWED;
}

/** True when the bot should stop scanning entirely rather than just skip a trade. */
export function shouldHalt(config: ArboConfig, state: BotState): string | undefined {
  if (config.killSwitch) return 'kill switch engaged';
  if (state.lossToday >= config.maxDailyLossUsd) {
    return `daily loss limit reached ($${state.lossToday.toFixed(2)})`;
  }
  if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
    return `${state.consecutiveFailures} consecutive failures`;
  }
  return undefined;
}
