/**
 * SCANETH Telegram connectivity test.
 *
 * Sends a test alert in the current format: token name, exact address,
 * scam rating, and pros/cons.
 */

import { loadConfig } from '../config';
import { ScanethNotifier } from './notifier';

async function main(): Promise<void> {
  const config = loadConfig();
  const notifier = new ScanethNotifier(config);

  const testMessage =
    `<b>SCANETH — New ETH token launched (test)</b>\n\n` +
    `<b>Example Token (EXAMPLE)</b>\n` +
    `Address: <code>0x1234567890123456789012345678901234567890</code>\n` +
    `Age: <b>12m</b>\n` +
    `Price: $0.00001234\n\n` +
    `<b>Scam rating: 10/100 — LOW RISK</b>\n` +
    `No major red flags detected. Still DYOR before buying.\n\n` +
    `<b>Pros</b>\n` +
    `✅ Sellable — simulated sell succeeded\n` +
    `✅ Liquidity locked or burned\n` +
    `✅ Ownership renounced\n` +
    `✅ Supply not overly concentrated\n` +
    `✅ Low tax (0.00%)\n\n` +
    `<b>Cons</b>\n` +
    `None flagged\n\n` +
    `<a href="https://etherscan.io/token/0x1234567890123456789012345678901234567890">Etherscan</a> · ` +
    `<a href="https://dexscreener.com/ethereum/0x1234567890123456789012345678901234567890">DEXScreener</a>`;

  const ok = await notifier.sendRaw(testMessage);
  if (!ok) {
    console.error('Test alert failed');
    process.exit(1);
  }

  console.log('Test alert delivered successfully');
  process.exit(0);
}

void main();
