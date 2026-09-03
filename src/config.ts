/**
 * SCANETH environment parsing and validation.
 *
 * New plan: alert on EVERY new ETH token launch as soon as the pair is created.
 * Safety checks run and are reported in the alert.
 */

import 'dotenv/config';

function str(key: string, fallback?: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return raw.trim();
}

function optionalStr(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (Number.isNaN(parsed)) throw new Error(`Invalid number for ${key}: ${raw}`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = optionalStr(key);
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export interface ScanethConfig {
  /** Ethereum RPC endpoint (HTTP). */
  rpcUrl: string;
  /** Optional WebSocket endpoint for real-time blocks. */
  wsUrl?: string;
  /** HTTP server port for healthchecks. */
  port: number;
  /** ETH amount used for buy/sell simulation. */
  probeEth: number;
  /** Max acceptable round-trip tax in bps for the safety check. */
  maxTaxBps: number;
  /** Flag if a single wallet holds more than this %. */
  maxTopHolderPct: number;
  /** How often to poll for new blocks when no WebSocket is available. */
  pollIntervalMs: number;
  /** How often to poll DEXScreener for ATH tracking on alerted tokens. */
  athPollIntervalMs: number;
  /** Enable ATH/PNL follow-up alerts. */
  athTrackerEnabled: boolean;
  /** Optional fixed starting block; if omitted the bot starts at the current head. */
  startBlock?: number;
  /** Optional historical scan range for backtesting. */
  backtest?: { from: number; to: number };
  /** Telegram credentials. */
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Send a test alert on boot. */
  telegramTestOnBoot: boolean;
  /** True when the bot should actually process blocks; false for dry-run. */
  enabled: boolean;
}

export function loadConfig(): ScanethConfig {
  const config: ScanethConfig = {
    rpcUrl: str('ETHEREUM_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    wsUrl: optionalStr('ETHEREUM_WS_URL'),
    port: num('PORT', 3000),
    probeEth: num('PROBE_ETH', 0.001),
    maxTaxBps: num('MAX_TAX_BPS', 1000),
    maxTopHolderPct: num('MAX_TOP_HOLDER_PCT', 50),
    pollIntervalMs: num('POLL_INTERVAL_MS', 12_000),
    athPollIntervalMs: num('ATH_POLL_INTERVAL_MS', 60_000),
    athTrackerEnabled: bool('ATH_TRACKER_ENABLED', false),
    startBlock: optionalStr('START_BLOCK') ? num('START_BLOCK', 0) : undefined,
    backtest: optionalStr('BACKTEST_FROM') && optionalStr('BACKTEST_TO')
      ? {
          from: num('BACKTEST_FROM', 0),
          to: num('BACKTEST_TO', 0),
        }
      : undefined,
    telegramBotToken: optionalStr('TELEGRAM_BOT_TOKEN'),
    telegramChatId: optionalStr('TELEGRAM_CHAT_ID'),
    telegramTestOnBoot: bool('TELEGRAM_TEST_ON_BOOT', false),
    enabled: bool('SCANETH_ENABLED', true),
  };

  validate(config);
  return config;
}

function validate(c: ScanethConfig): void {
  const problems: string[] = [];

  if (c.probeEth <= 0) problems.push('PROBE_ETH must be > 0');
  if (c.maxTaxBps < 0) problems.push('MAX_TAX_BPS cannot be negative');
  if (c.maxTopHolderPct < 0 || c.maxTopHolderPct > 100) {
    problems.push('MAX_TOP_HOLDER_PCT must be between 0 and 100');
  }
  if (c.pollIntervalMs < 1_000) {
    problems.push('POLL_INTERVAL_MS below 1000 will hammer the RPC');
  }
  if (c.athPollIntervalMs < 5_000) {
    problems.push('ATH_POLL_INTERVAL_MS below 5000 will hammer DEXScreener');
  }
  if (c.backtest && c.backtest.to < c.backtest.from) {
    problems.push('BACKTEST_TO must be greater than or equal to BACKTEST_FROM');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid SCANETH configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
