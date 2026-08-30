/**
 * SCANETH Telegram notifier.
 *
 * Optional alerts for new low-risk token launches. If no credentials are
 * configured, every call is a no-op.
 */

import { createLogger, errMeta } from '../logger';
import type { ScanethConfig } from '../config';
import type { TokenLaunch } from './types';
import { formatAlert } from './analyzer';

const log = createLogger('scaneth:telegram');
const MAX_MESSAGE_LENGTH = 3800;

export class ScanethNotifier {
  private readonly enabled: boolean;
  private lastSentAt = 0;
  private readonly minIntervalMs = 1_200;

  constructor(private readonly config: ScanethConfig) {
    this.enabled = !!config.telegramBotToken && !!config.telegramChatId;
    if (!this.enabled) {
      log.info('telegram alerts disabled (no token/chat id configured)');
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async alertLaunch(launch: TokenLaunch, chainLabel: string): Promise<boolean> {
    return this.sendChecked(formatAlert(launch, chainLabel));
  }

  async test(): Promise<boolean> {
    return this.sendChecked(
      `<b>SCANETH — Telegram test</b>\n\n` +
        `Connection verified. Low-risk token launch alerts will arrive here.`,
    );
  }

  async error(scope: string, message: string): Promise<void> {
    await this.send(
      `<b>SCANETH error</b> [${escapeHtml(scope)}]\n<code>${escapeHtml(message.slice(0, 500))}</code>`,
    );
  }

  private async send(text: string): Promise<void> {
    await this.sendChecked(text);
  }

  private async sendChecked(text: string): Promise<boolean> {
    if (!this.enabled) return false;

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
        let detail = '';
        try {
          detail = (await response.text()).slice(0, 300);
        } catch {
          // ignore
        }
        log.warn('telegram rejected message', { status: response.status, detail });
        return false;
      }
      return true;
    } catch (err) {
      log.warn('telegram send failed', errMeta(err));
      return false;
    }
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
