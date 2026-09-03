/**
 * SCANETH Telegram connectivity test.
 *
 * Sends test alerts in the current formats:
 *   1. New launch alert with scam rating and pros/cons.
 *   2. Daily winners report with top 5 tokens, ATH, and PNL.
 */

import { loadConfig } from '../config';
import { ScanethNotifier } from './notifier';

async function main(): Promise<void> {
  const config = loadConfig();
  const notifier = new ScanethNotifier(config);

  const launchAlert =
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

  const dailyReport =
    `<b>SCANETH — Daily winners report (test)</b>\n\n` +
    `1. <b>MoonETH (MOON)</b>\n` +
    `   Address: <code>0x1111111111111111111111111111111111111111</code>\n` +
    `   Entry: $0.00000100 → ATH: $0.00004500\n` +
    `   PNL: <b>+4400.00%</b>\n\n` +
    `2. <b>RocketToken (RKT)</b>\n` +
    `   Address: <code>0x2222222222222222222222222222222222222222</code>\n` +
    `   Entry: $0.00000200 → ATH: $0.00002000\n` +
    `   PNL: <b>+900.00%</b>\n\n` +
    `3. <b>AlphaCoin (ALFA)</b>\n` +
    `   Address: <code>0x3333333333333333333333333333333333333333</code>\n` +
    `   Entry: $0.00000500 → ATH: $0.00003000\n` +
    `   PNL: <b>+500.00%</b>`;

  let ok = await notifier.sendRaw(launchAlert);
  if (!ok) {
    console.error('Launch test alert failed');
    process.exit(1);
  }

  ok = await notifier.sendRaw(dailyReport);
  if (!ok) {
    console.error('Daily report test alert failed');
    process.exit(1);
  }

  console.log('Both test alerts delivered successfully');
  process.exit(0);
}

void main();
