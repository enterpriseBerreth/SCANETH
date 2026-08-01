/**
 * Telegram alerts. Entirely optional — if no token is configured every call
 * here is a no-op, so the bot never fails because messaging is unavailable.
 */

import { createLogger, errMeta } from './logger';
import type { ArboConfig } from './config';
import type { ArbOpportunity, CexSpread, ExecutionResult } from './types';

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

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

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
        log.warn('telegram rejected message', { status: response.status });
      }
    } catch (err) {
      // Never let a messaging failure disturb trading.
      log.warn('telegram send failed', errMeta(err));
    }
  }

  async startup(chains: string[], mode: string): Promise<void> {
    await this.send(
      `<b>ARBO online</b>\nmode: <code>${mode}</code>\nchains: <code>${chains.join(', ')}</code>`,
    );
  }

  async opportunity(opportunity: ArbOpportunity, route: string): Promise<void> {
    await this.send(
      `<b>Arb opportunity</b> — ${opportunity.chain}\n` +
        `route: <code>${route}</code>\n` +
        `size: $${opportunity.notionalUsd.toFixed(0)}\n` +
        `gross: $${opportunity.grossProfitUsd.toFixed(2)}\n` +
        `gas: $${opportunity.gasCostUsd.toFixed(2)}\n` +
        `<b>net: $${opportunity.netProfitUsd.toFixed(2)}</b>`,
    );
  }

  async executed(result: ExecutionResult, route: string): Promise<void> {
    if (!result.submitted) return;
    const profit = result.realisedProfitUsd ?? 0;
    const heading = profit >= 0 ? 'Arb filled' : 'Arb lost money';
    await this.send(
      `<b>${heading}</b>\n` +
        `route: <code>${route}</code>\n` +
        `realised: $${profit.toFixed(2)}\n` +
        `gas: $${(result.gasSpentUsd ?? 0).toFixed(2)}\n` +
        (result.txHash ? `tx: <code>${result.txHash}</code>` : ''),
    );
  }

  async cexSpread(spread: CexSpread): Promise<void> {
    await this.send(
      `<b>CEX spread</b> — ${spread.symbol}\n` +
        `buy ${spread.buyVenue} @ ${spread.buyPrice}\n` +
        `sell ${spread.sellVenue} @ ${spread.sellPrice}\n` +
        `net: <b>${spread.netBps.toFixed(1)} bps</b> on ~$${spread.availableUsd.toFixed(0)}\n` +
        `<i>requires pre-funded inventory on both venues</i>`,
    );
  }

  async halted(reason: string): Promise<void> {
    await this.send(`<b>ARBO halted</b>\nreason: <code>${reason}</code>`);
  }

  async error(scope: string, message: string): Promise<void> {
    await this.send(`<b>ARBO error</b> [${scope}]\n<code>${message.slice(0, 500)}</code>`);
  }
}
