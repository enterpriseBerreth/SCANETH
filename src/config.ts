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
  /** Backup RPC used when the primary fails or times out mid-scan. */
  fallbackRpcUrl: string;
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
  /** How often to poll DEXScreener for price tracking on alerted tokens. */
  athPollIntervalMs: number;
  /** Enable ATH/PNL follow-up alerts. */
  athTrackerEnabled: boolean;
  /** Enable daily 12:00am MST winners report. */
  dailyReportEnabled: boolean;
  /** UTC hour at which the daily report is sent. 12:00am MST = UTC-7 = 07:00 UTC. */
  dailyReportHourUtc: number;
  /** Optional fixed starting block; if omitted the bot starts at the current head. */
  startBlock?: number;
  /** Optional historical scan range for backtesting. */
  backtest?: { from: number; to: number };
  /** Telegram credentials. */
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Send a test alert on boot. */
  telegramTestOnBoot: boolean;
  /** Enable paper copytrader. */
  copytraderEnabled: boolean;
  /** Comma-separated list of wallet addresses to copy. */
  copytraderWatchedWallets: string[];
  /** Comma-separated wallet addresses observed for stats only — never copied. */
  copytraderShadowWallets: string[];
  /** USD amount to simulate on each copied buy. */
  copytraderBuyAmountUsd: number;
  /** Paper trading budget. Buys stop when cash is exhausted. */
  copytraderStartingBudgetUsd: number;
  /** Auto-scout engine: discover profitable wallets and replace underperformers. */
  copytraderAutoScoutEnabled: boolean;
  /** Maximum number of wallets the copytrader may watch. */
  copytraderMaxWallets: number;
  /** Hours between scout cycles. */
  copytraderScoutIntervalHours: number;
  /** Auto-sell paper positions when they drop this % below entry. 0 disables. */
  copytraderStopLossPct: number;
  /**
   * Simulated slippage on paper fills (%): entries pay above market, exits
   * receive below market. Makes paper PNL realistic for live capital.
   */
  copytraderSlippagePct: number;
  /** Simulated gas cost per paper trade (buys AND sells), in USD. */
  copytraderGasFeeUsd: number;
  /**
   * Minimum DEX pool liquidity (USD) for a copyable token: entries below the
   * floor are skipped and exits into thinner pools are refused — real capital
   * could not fill them.
   */
  copytraderMinLiquidityUsd: number;
  /**
   * Simulated fill-failure rate (% of entries): anti-bot launch windows,
   * reverting buy taxes and gas wars make some real fills impossible.
   * Deterministic per-tx so restarts replay the same outcomes.
   */
  copytraderFillFailurePct: number;
  /** Probability (% of entries) of being sandwiched by MEV bots. */
  copytraderSandwichProbPct: number;
  /** Extra entry cost (%) when a sandwich hits. */
  copytraderSandwichCostPct: number;
  /** Slippage (%) on panic exits (stop-loss, reconciled sells) — dumps run hot. */
  copytraderPanicSlippagePct: number;
  /** Skip entries whose simulated sell tax exceeds this %. */
  copytraderMaxSellTaxPct: number;
  /** Scout lookback window (days) for candidate evaluation. */
  copytraderScoutWindowDays: number;
  /** Scout: candidate must have traded on at least this many distinct days in the window. */
  copytraderScoutMinActiveDays: number;
  /** Scout: candidate must have completed at least this many round trips in the window. */
  copytraderScoutMinRoundTrips: number;
  /** Scout: candidate aggregate PNL% over the window must be at least this. */
  copytraderScoutMinPnlPct: number;
  /** File path for persisted paper-account state. Empty string disables persistence. */
  copytraderStatePath: string;
  /** Shared secret for admin endpoints (/dump, /restore, /exit, /reset). */
  copytraderAdminKey?: string;
  /** True when the bot should actually process blocks; false for dry-run. */
  enabled: boolean;
}

function addressList(key: string): string[] {
  const raw = optionalStr(key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.startsWith('0x') && a.length === 42);
}

export function loadConfig(): ScanethConfig {
  const rpcUrl = str('ETHEREUM_RPC_URL', 'https://ethereum-rpc.publicnode.com');
  const config: ScanethConfig = {
    rpcUrl,
    fallbackRpcUrl: str('ETHEREUM_FALLBACK_RPC_URL', rpcUrl.includes('publicnode.com')
      ? 'https://eth.drpc.org'
      : 'https://ethereum-rpc.publicnode.com'),
    wsUrl: optionalStr('ETHEREUM_WS_URL'),
    port: num('PORT', 3000),
    probeEth: num('PROBE_ETH', 0.001),
    maxTaxBps: num('MAX_TAX_BPS', 1000),
    maxTopHolderPct: num('MAX_TOP_HOLDER_PCT', 50),
    pollIntervalMs: num('POLL_INTERVAL_MS', 12_000),
    athPollIntervalMs: num('ATH_POLL_INTERVAL_MS', 60_000),
    athTrackerEnabled: bool('ATH_TRACKER_ENABLED', false),
    dailyReportEnabled: bool('DAILY_REPORT_ENABLED', true),
    dailyReportHourUtc: num('DAILY_REPORT_HOUR_UTC', 7),
    copytraderEnabled: bool('COPYTRADER_ENABLED', false),
    copytraderWatchedWallets: addressList('COPYTRADER_WATCHED_WALLETS'),
    copytraderShadowWallets: addressList('COPYTRADER_SHADOW_WALLETS'),
    copytraderBuyAmountUsd: num('COPYTRADER_BUY_AMOUNT_USD', 20),
    copytraderStartingBudgetUsd: num('COPYTRADER_STARTING_BUDGET_USD', 1000),
    copytraderAutoScoutEnabled: bool('COPYTRADER_AUTO_SCOUT_ENABLED', true),
    copytraderMaxWallets: num('COPYTRADER_MAX_WALLETS', 12),
    copytraderScoutIntervalHours: num('COPYTRADER_SCOUT_INTERVAL_HOURS', 12),
    copytraderStopLossPct: num('COPYTRADER_STOP_LOSS_PCT', 40),
    copytraderSlippagePct: num('COPYTRADER_SLIPPAGE_PCT', 2),
    copytraderGasFeeUsd: num('COPYTRADER_GAS_FEE_USD', 5),
    copytraderMinLiquidityUsd: num('COPYTRADER_MIN_LIQUIDITY_USD', 10_000),
    copytraderFillFailurePct: num('COPYTRADER_FILL_FAILURE_PCT', 10),
    copytraderSandwichProbPct: num('COPYTRADER_SANDWICH_PROB_PCT', 20),
    copytraderSandwichCostPct: num('COPYTRADER_SANDWICH_COST_PCT', 2),
    copytraderPanicSlippagePct: num('COPYTRADER_PANIC_SLIPPAGE_PCT', 5),
    copytraderMaxSellTaxPct: num('COPYTRADER_MAX_SELL_TAX_PCT', 30),
    copytraderScoutWindowDays: num('COPYTRADER_SCOUT_WINDOW_DAYS', 5),
    copytraderScoutMinActiveDays: num('COPYTRADER_SCOUT_MIN_ACTIVE_DAYS', 3),
    copytraderScoutMinRoundTrips: num('COPYTRADER_SCOUT_MIN_ROUND_TRIPS', 5),
    copytraderScoutMinPnlPct: num('COPYTRADER_SCOUT_MIN_PNL_PCT', 20),
    copytraderStatePath: optionalStr('COPYTRADER_STATE_PATH') ?? 'data/paper-state.json',
    copytraderAdminKey: optionalStr('COPYTRADER_ADMIN_KEY'),
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
  if (c.dailyReportHourUtc < 0 || c.dailyReportHourUtc > 23) {
    problems.push('DAILY_REPORT_HOUR_UTC must be 0-23');
  }
  if (c.copytraderBuyAmountUsd <= 0) {
    problems.push('COPYTRADER_BUY_AMOUNT_USD must be > 0');
  }
  if (c.copytraderStartingBudgetUsd <= 0) {
    problems.push('COPYTRADER_STARTING_BUDGET_USD must be > 0');
  }
  if (c.copytraderStopLossPct < 0 || c.copytraderStopLossPct > 100) {
    problems.push('COPYTRADER_STOP_LOSS_PCT must be 0-100 (0 disables)');
  }
  if (c.copytraderSlippagePct < 0 || c.copytraderSlippagePct > 50) {
    problems.push('COPYTRADER_SLIPPAGE_PCT must be 0-50');
  }
  if (c.copytraderGasFeeUsd < 0) {
    problems.push('COPYTRADER_GAS_FEE_USD must be >= 0');
  }
  if (c.copytraderMinLiquidityUsd < 0) {
    problems.push('COPYTRADER_MIN_LIQUIDITY_USD must be >= 0');
  }
  for (const [name, val] of [
    ['COPYTRADER_FILL_FAILURE_PCT', c.copytraderFillFailurePct],
    ['COPYTRADER_SANDWICH_PROB_PCT', c.copytraderSandwichProbPct],
    ['COPYTRADER_SANDWICH_COST_PCT', c.copytraderSandwichCostPct],
    ['COPYTRADER_PANIC_SLIPPAGE_PCT', c.copytraderPanicSlippagePct],
  ] as const) {
    if (val < 0 || val > 100) {
      problems.push(`${name} must be 0-100`);
    }
  }
  if (c.copytraderMaxSellTaxPct < 0 || c.copytraderMaxSellTaxPct > 95) {
    problems.push('COPYTRADER_MAX_SELL_TAX_PCT must be 0-95');
  }
  if (c.copytraderScoutWindowDays < 1 || c.copytraderScoutWindowDays > 30) {
    problems.push('COPYTRADER_SCOUT_WINDOW_DAYS must be 1-30');
  }
  if (c.copytraderScoutMinActiveDays < 1 || c.copytraderScoutMinActiveDays > c.copytraderScoutWindowDays) {
    problems.push('COPYTRADER_SCOUT_MIN_ACTIVE_DAYS must be 1..WINDOW_DAYS');
  }
  if (c.copytraderScoutMinRoundTrips < 1) {
    problems.push('COPYTRADER_SCOUT_MIN_ROUND_TRIPS must be >= 1');
  }
  if (c.backtest && c.backtest.to < c.backtest.from) {
    problems.push('BACKTEST_TO must be greater than or equal to BACKTEST_FROM');
  }

  if (problems.length > 0) {
    throw new Error(`Invalid SCANETH configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
