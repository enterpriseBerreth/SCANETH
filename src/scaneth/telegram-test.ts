/**
 * SCANETH Telegram connectivity test.
 *
 * Sends an initial-alert test message and a simulated ATH follow-up alert.
 */

import { loadConfig } from '../config';
import { ScanethNotifier } from './notifier';

async function main(): Promise<void> {
  const config = loadConfig();
  const notifier = new ScanethNotifier(config);

  const initialMessage =
    `<b>SCANETH — New launch hit 7 buys (test)</b>\n\n` +
    `<b>Example Token (EXAMPLE)</b>\n` +
    `Address: <code>0x1234567890123456789012345678901234567890</code>\n` +
    `Age: <b>12m</b>\n` +
    `Price: $0.00001234\n\n` +
    `<b>Legitimacy check</b>\n` +
    `✅ Looks legitimate — no major red flags. Potential good buy.\n\n` +
    `Risk score: 5/100 (low) · Safety score: 10/100\n\n` +
    `<a href="https://etherscan.io/token/0x1234567890123456789012345678901234567890">Etherscan</a> · ` +
    `<a href="https://dexscreener.com/ethereum/0x1234567890123456789012345678901234567890">DEXScreener</a>`;

  const initialOk = await notifier.sendRaw(initialMessage);
  if (!initialOk) {
    console.error('Initial test alert failed');
    process.exit(1);
  }

  // Simulate an ATH follow-up alert to verify formatting.
  const athMessage =
    `<b>SCANETH — ATH update (test)</b>\n\n` +
    `<b>Example Token (EXAMPLE)</b>\n` +
    `Address: <code>0x1234567890123456789012345678901234567890</code>\n\n` +
    `<b>Entry price</b> (at initial alert)\n` +
    `$0.00001234\n\n` +
    `<b>Daily ATH</b>\n` +
    `$0.00004567\n\n` +
    `<b>Unrealized PNL</b>\n` +
    `<b>+270.10%</b>\n\n` +
    `This is a test of the ATH follow-up alert format.`;

  const athOk = await notifier.sendRaw(athMessage);
  if (!athOk) {
    console.error('ATH follow-up test alert failed');
    process.exit(1);
  }

  console.log('Both test alerts delivered successfully');
  process.exit(0);
}

void main();
