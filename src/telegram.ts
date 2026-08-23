/**
 * Telegram alerts. Entirely optional — if no token is configured every call
 * here is a no-op, so the bot never fails because messaging is unavailable.
 */

import { createLogger, errMeta } from './logger';
import type { ArboConfig } from './config';
import type { CexDexExecutionResult, CexDexOpportunity, ExecutionResult } from './types';
import type { PaperTrade } from './paper';

const log = createLogger('telegram');

/** Telegram rejects messages over 4096 characters. */
const MAX_MESSAGE_LENGTH = 3800;

export class Notifier {
  private readonly enabled: boolean;
  private lastSentAt = 0;
  /** Telegram tolerates roughly one message per second per chat. */
  private readonly minIntervalMs = 1_200;

  constructor(private readonly config: ArboConfig) {
    this.enabled = !!config.telegramBotToken && !!config.telegramChatId;
    if (!this.enabled) {
      log.info('telegram alerts disabled (no token/chat id configured)');
    }
  }

  /** Send without checking success. */
  async send(text: string): Promise<void> {
    await this.sendChecked(text);
  }

  /** As `send`, but reports whether Telegram actually accepted the message. */
  private async sendChecked(text: string): Promise<boolean> {
    if (!this.enabled) return false;

    // Crude spacing so a burst of opportunities cannot trip rate limits.
    const sinceLast = Date.now() - this.lastSentAt;
    if (sinceLast < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - sinceLast));
    }
    this.lastSentAt = Date.now();

    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: text.slice(0, MAX_MESSAGE_LENGTH),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        // Telegram explains refusals in the body, and the reason is almost always
        // actionable (bad token, wrong chat id, bot never started by the user).
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 300);
        } catch {
          // Body already consumed or unreadable; status alone still tells us enough.
        }
        log.warn('telegram rejected message', { status: response.status, detail });
        return false;
      }
      return true;
    } catch (err) {
      // Never let a messaging failure disturb trading.
      log.warn('telegram send failed', errMeta(err));
      return false;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * A completed live trade. Kept deliberately parallel to `paperTrade` so the
   * alert stream reads identically once real capital is switched on.
   */
  async executed(result: ExecutionResult, route: string): Promise<void> {
    if (!result.submitted) return;
    const profit = result.realisedProfitUsd ?? 0;
    const heading = profit >= 0 ? 'Arb filled' : 'Arb lost money';
    await this.send(
      `<b>${heading}</b>\n` +
        `route: <code>${escapeHtml(route)}</code>\n` +
        `realised: $${profit.toFixed(2)}\n` +
        `gas: $${(result.gasSpentUsd ?? 0).toFixed(2)}\n` +
        (result.txHash ? `tx: <code>${result.txHash}</code>` : ''),
    );
  }

  /**
   * Sent after every settled paper trade — wins and losses alike.
   *
   * Losses are included deliberately. An alert stream showing only fills would
   * misrepresent the strategy, since gas on a decayed edge is a real debit
   * against the balance and is exactly what a live account would have paid.
   */
  async paperTrade(trade: PaperTrade): Promise<void> {
    const win = trade.actualNetUsd >= 0;
    const heading = win ? 'Paper trade — PROFIT' : 'Paper trade — LOSS';
    const sign = win ? '+' : '-';
    const magnitude = Math.abs(trade.actualNetUsd);
    const pct = Math.abs(trade.pnlPct);

    await this.send(
      `<b>${heading}</b>\n\n` +
        `Token: <b>${escapeHtml(trade.tokenPath)}</b>\n` +
        `PNL: <b>${sign}$${magnitude.toFixed(2)}</b>\n` +
        `PNL %: <b>${sign}${pct.toFixed(2)}%</b>\n` +
        `Capital before: $${trade.capitalBeforeUsd.toFixed(2)}\n` +
        `Capital after: <b>$${trade.capitalAfterUsd.toFixed(2)}</b>\n\n` +
        `<i>${trade.chain} · ${trade.outcome} · size $${trade.notionalUsd.toFixed(0)} · ` +
        `gas $${trade.gasCostUsd.toFixed(2)}</i>`,
    );
  }

  /**
   * Connectivity check. Returns whether Telegram accepted the message, so a
   * misconfigured token surfaces at boot rather than at the first trade.
   */
  async test(mode: string, capitalUsd: number): Promise<boolean> {
    return this.sendChecked(
      `<b>ARBO — Telegram test</b>\n\n` +
        `Connection verified. Trade alerts will arrive here.\n\n` +
        `Mode: <code>${escapeHtml(mode)}</code>\n` +
        `Starting capital: <b>$${capitalUsd.toFixed(2)}</b>\n\n` +
        `<i>Each alert reports token, PNL $, PNL %, and capital before and after.</i>`,
    );
  }

  /**
   * Operational failure. Not a trade, but the one exception worth interrupting
   * for: a bot that has stopped trading looks identical to a quiet market, and
   * silently discovering that days later is worse than one extra message.
   */
  async halted(reason: string): Promise<void> {
    await this.send(`<b>ARBO halted</b>\nreason: <code>${escapeHtml(reason)}</code>`);
  }

  /**
   * Alert for a completed CEX-DEX round trip. Sent only on filled outcomes so
   * the channel does not fill with skips and cooldowns.
   */
  async cexDexTrade(result: CexDexExecutionResult, opportunity: CexDexOpportunity): Promise<void> {
    const win = (result.realisedProfitUsd ?? 0) >= 0;
    const heading = win ? 'CEX-DEX — PROFIT' : 'CEX-DEX — LOSS';
    const sign = win ? '+' : '-';
    const magnitude = Math.abs(result.realisedProfitUsd ?? 0);
    const pct = result.capitalBeforeUsd > 0 ? (magnitude / result.capitalBeforeUsd) * 100 : 0;

    await this.send(
      `<b>${heading}</b>\n\n` +
        `Token: <b>${escapeHtml(opportunity.symbol)}</b>\n` +
        `CEX: ${escapeHtml(opportunity.cex)} · Chain: ${escapeHtml(opportunity.chain)}\n` +
        `Direction: ${opportunity.buyOnDex ? 'buy DEX / sell CEX' : 'buy CEX / sell DEX'}\n` +
        `PNL: <b>${sign}$${magnitude.toFixed(2)}</b>\n` +
        `PNL %: <b>${sign}${pct.toFixed(2)}%</b>\n` +
        `Capital before: $${result.capitalBeforeUsd.toFixed(2)}\n` +
        `Capital after: <b>$${result.capitalAfterUsd.toFixed(2)}</b>\n\n` +
        `<i>size $${opportunity.notionalUsd.toFixed(0)} · ` +
        `cex fee $${opportunity.cexFeeUsd.toFixed(2)} · ` +
        `dex fee $${opportunity.dexFeeUsd.toFixed(2)} · ` +
        `transfer $${opportunity.transferCostUsd.toFixed(2)} · ` +
        `gas $${(result.gasSpentUsd ?? 0).toFixed(2)}</i>`,
    );
  }

  async error(scope: string, message: string): Promise<void> {
    await this.send(
      `<b>ARBO error</b> [${escapeHtml(scope)}]\n<code>${escapeHtml(message.slice(0, 500))}</code>`,
    );
  }
}

/**
 * Telegram parses these three characters as markup in HTML mode, so any value
 * interpolated from chain data has to be escaped or the whole message is
 * rejected with a 400 and the alert is silently lost.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
