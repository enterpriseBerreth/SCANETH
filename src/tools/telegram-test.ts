/**
 * Telegram connectivity check.
 *
 * Run with: npm run telegram:test
 *
 * Deliberately goes through the real `Notifier` rather than calling the Telegram
 * API directly. A test that bypasses the production code path can pass while the
 * bot itself stays silent — which is precisely the failure this is meant to
 * catch. Exits non-zero if the message was not accepted, so it is usable as a
 * pre-deploy gate.
 */

import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { Notifier } from '../telegram';
import type { PaperTrade } from '../paper';

const log = createLogger('telegram-test');

/**
 * A representative settled trade, used only to render the alert format so it can
 * be eyeballed before real trades depend on it. Values are plainly synthetic.
 */
function sampleTrade(capitalUsd: number): PaperTrade {
  const net = 12.47;
  const now = Date.now();
  return {
    kind: 'trade',
    id: 'sample',
    chain: 'base',
    route: 'WETH/USDC uniswap-v3->aerodrome',
    baseSymbol: 'WETH',
    tokenPath: 'WETH -> USDC -> WETH',
    notionalUsd: 8_400,
    detectedAt: now - 3_000,
    expectedGrossUsd: 15.02,
    expectedNetUsd: 13.1,
    settledAt: now,
    settleDelayMs: 3_000,
    gasCostUsd: 1.93,
    actualGrossUsd: 14.4,
    actualNetUsd: net,
    decayBps: 0.74,
    outcome: 'filled',
    wouldExecuteLive: true,
    capitalBeforeUsd: capitalUsd,
    capitalAfterUsd: capitalUsd + net,
    pnlPct: (net / capitalUsd) * 100,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.telegramBotToken || !config.telegramChatId) {
    log.error('telegram is not configured', {
      hasToken: !!config.telegramBotToken,
      hasChatId: !!config.telegramChatId,
      hint: 'set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env',
    });
    process.exitCode = 1;
    return;
  }

  const notifier = new Notifier(config);
  const delivered = await notifier.test(config.mode, config.paperStartingCapitalUsd);

  if (delivered) {
    log.info('test alert delivered — telegram is connected', {
      chatId: config.telegramChatId,
      mode: config.mode,
      startingCapitalUsd: config.paperStartingCapitalUsd,
    });
    // Follow up with the real trade format, so what arrives in the chat is the
    // same shape every future trade will use rather than a bespoke test message.
    await notifier.paperTrade(sampleTrade(config.paperStartingCapitalUsd));
    log.info('sample trade alert sent — this is the exact format live trades will use');
    return;
  }

  // The notifier already logged the API response, which names the cause.
  log.error('test alert was NOT delivered', {
    hint:
      'verify the token, confirm the chat id, and make sure you have sent /start ' +
      'to the bot at least once — Telegram refuses messages to a chat that has ' +
      'never initiated contact',
  });
  process.exitCode = 1;
}

main().catch((err) => {
  log.error('telegram test failed', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
