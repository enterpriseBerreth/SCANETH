/**
 * SCANETH Telegram connectivity test.
 *
 * Sends a test message and exits non-zero if Telegram refuses it.
 */

import { loadConfig } from '../config';
import { ScanethNotifier } from './notifier';

async function main(): Promise<void> {
  const config = loadConfig();
  const notifier = new ScanethNotifier(config);
  const ok = await notifier.test();
  process.exit(ok ? 0 : 1);
}

void main();
