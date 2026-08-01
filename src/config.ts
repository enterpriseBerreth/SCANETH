/**
 * Environment parsing and validation.
 *
 * Deliberately strict: the bot refuses to boot in `live` mode unless every
 * credential needed to trade safely is present. A misconfigured arbitrage bot
 * loses money silently, so we fail loudly at startup instead.
 */

import 'dotenv/config';
import type { ChainName, Mode } from './types';

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
  const raw = optionalStr(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got "${raw}"`);
  }
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = optionalStr(key);
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

function list(key: string, fallback: string[]): string[] {
  const raw = optionalStr(key);
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SUPPORTED_CHAINS: ChainName[] = ['base', 'arbitrum', 'ethereum'];

export interface ArboConfig {
  mode: Mode;
  chains: ChainName[];
  rpcUrls: Record<ChainName, string>;
  /** Optional wss:// endpoints; enables block-triggered scanning per chain. */
  wsUrls: Partial<Record<ChainName, string>>;
  /** Fallback block-polling cadence, used when a chain has no WebSocket URL. */
  blockPollIntervalMs: number;
  privateSubmitRpcUrl?: string;
  contractAddresses: Partial<Record<ChainName, string>>;
  executorPrivateKey?: string;

  minProfitUsd: number;
  maxTradeUsd: number;
  minTradeUsd: number;
  slippageBps: number;
  /** Pools holding less than this are treated as dead and excluded entirely. */
  minPoolLiquidityUsd: number;

  /** Where the paper-trading ledger is appended, as newline-delimited JSON. */
  paperLedgerPath: string;
  /** Simulated starting balance. Paper P&L compounds against this. */
  paperStartingCapitalUsd: number;
  /**
   * Send a connectivity probe on boot. Off by default: the alert stream is meant
   * to contain settled trades only, and redeploys are frequent enough that this
   * would otherwise dominate it. Use `npm run telegram:test` instead.
   */
  telegramTestOnBoot: boolean;
  /** How long a paper candidate is held before being re-quoted and booked. */
  paperSettleDelayMs: number;
  /** Cadence for the cumulative report and market-conditions rollup. */
  paperReportIntervalMs: number;

  maxDailyLossUsd: number;
  maxConsecutiveFailures: number;
  failureCooldownMs: number;
  killSwitch: boolean;

  scanIntervalMs: number;
  gasLimitEstimate: bigint;

  cexEnabled: boolean;
  cexExchanges: string[];
  cexSymbols: string[];
  cexMinSpreadBps: number;
  cexScanIntervalMs: number;
  cexTransferCostBps: number;

  telegramBotToken?: string;
  telegramChatId?: string;

  port: number;
  runOnce: boolean;
}

export function loadConfig(): ArboConfig {
  // Defaults to paper rather than simulate: the point of running this is to build
  // a track record, and a mode that records nothing cannot produce one.
  const mode = str('MODE', 'paper').toLowerCase();
  const modes: Mode[] = ['simulate', 'paper', 'live'];
  if (!modes.includes(mode as Mode)) {
    throw new Error(`MODE must be one of ${modes.join(', ')} — got "${mode}"`);
  }

  const chains = list('ENABLED_CHAINS', ['base', 'arbitrum']).map((c) => c.toLowerCase());
  for (const c of chains) {
    if (!SUPPORTED_CHAINS.includes(c as ChainName)) {
      throw new Error(`Unsupported chain "${c}". Supported: ${SUPPORTED_CHAINS.join(', ')}`);
    }
  }
  if (chains.length === 0) {
    throw new Error('ENABLED_CHAINS resolved to an empty list — nothing to scan.');
  }

  // Defaults are benchmarked, not guessed. `mainnet.base.org` — the obvious
  // choice — throttles a concurrent quote burst to ~2.2s versus ~260ms here,
  // which turned a Base scan pass into 49s of mostly waiting. Measure again with
  // `node scripts/bench-rpc.mjs` before changing these, and override per-deploy
  // with the env vars if you have a paid endpoint (strongly recommended for live
  // mode, where latency is the difference between winning and missing a fill).
  const rpcUrls: Record<ChainName, string> = {
    base: str('BASE_RPC_URL', 'https://base-rpc.publicnode.com'),
    arbitrum: str('ARBITRUM_RPC_URL', 'https://arb1.arbitrum.io/rpc'),
    ethereum: str('ETHEREUM_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
  };

  // WebSocket endpoints are optional. When present, scans are triggered by new
  // heads instead of a timer, which is the difference between quoting the current
  // block and quoting a block that has already been replaced. Absent one, the bot
  // polls block numbers — still block-aligned, just a little later.
  const wsUrls: Partial<Record<ChainName, string>> = {};
  const baseWs = optionalStr('BASE_WS_URL');
  const arbWs = optionalStr('ARBITRUM_WS_URL');
  const ethWs = optionalStr('ETHEREUM_WS_URL');
  if (baseWs) wsUrls.base = baseWs;
  if (arbWs) wsUrls.arbitrum = arbWs;
  if (ethWs) wsUrls.ethereum = ethWs;

  const contractAddresses: Partial<Record<ChainName, string>> = {};
  const baseContract = optionalStr('ARB_CONTRACT_BASE');
  const arbContract = optionalStr('ARB_CONTRACT_ARBITRUM');
  const ethContract = optionalStr('ARB_CONTRACT_ETHEREUM');
  if (baseContract) contractAddresses.base = baseContract;
  if (arbContract) contractAddresses.arbitrum = arbContract;
  if (ethContract) contractAddresses.ethereum = ethContract;

  const executorPrivateKey = optionalStr('EXECUTOR_PRIVATE_KEY');

  const config: ArboConfig = {
    mode: mode as Mode,
    chains: chains as ChainName[],
    rpcUrls,
    wsUrls,
    // Base and Arbitrum both produce blocks faster than this, but polling harder
    // burns request budget on public endpoints for little gain. A WebSocket URL
    // is the real fix; this is the floor.
    blockPollIntervalMs: num('BLOCK_POLL_INTERVAL_MS', 2_000),
    privateSubmitRpcUrl: optionalStr('PRIVATE_SUBMIT_RPC_URL'),
    contractAddresses,
    executorPrivateKey,

    minProfitUsd: num('MIN_PROFIT_USD', 5),
    maxTradeUsd: num('MAX_TRADE_USD', 25_000),
    minTradeUsd: num('MIN_TRADE_USD', 200),
    slippageBps: num('SLIPPAGE_BPS', 30),
    // Abandoned pools never get arbitraged back to fair value because correcting
    // them costs more than they hold, so they sit at arbitrary prices and generate
    // phantom edges of 100%+. Excluding them is what makes the edge numbers real.
    minPoolLiquidityUsd: num('MIN_POOL_LIQUIDITY_USD', 25_000),

    paperLedgerPath: str('PAPER_LEDGER_PATH', './data/paper-trades.jsonl'),
    paperStartingCapitalUsd: num('PAPER_STARTING_CAPITAL_USD', 1_000),
    telegramTestOnBoot: bool('TELEGRAM_TEST_ON_BOOT', false),
    // Held long enough to capture real edge decay. Detection to inclusion in
    // practice spans signing, propagation and at least one block, so settling
    // instantly would measure nothing and report a fill rate near 100%.
    paperSettleDelayMs: num('PAPER_SETTLE_DELAY_MS', 3_000),
    paperReportIntervalMs: num('PAPER_REPORT_INTERVAL_MS', 300_000),

    maxDailyLossUsd: num('MAX_DAILY_LOSS_USD', 100),
    maxConsecutiveFailures: num('MAX_CONSECUTIVE_FAILURES', 5),
    failureCooldownMs: num('FAILURE_COOLDOWN_MS', 60_000),
    killSwitch: bool('KILL_SWITCH', false),

    scanIntervalMs: num('SCAN_INTERVAL_MS', 4_000),
    gasLimitEstimate: BigInt(Math.trunc(num('GAS_LIMIT_ESTIMATE', 520_000))),

    cexEnabled: bool('CEX_ENABLED', true),
    cexExchanges: list('CEX_EXCHANGES', ['binance', 'kraken', 'coinbase', 'okx', 'bybit']),
    cexSymbols: list('CEX_SYMBOLS', ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']),
    cexMinSpreadBps: num('CEX_MIN_SPREAD_BPS', 30),
    cexScanIntervalMs: num('CEX_SCAN_INTERVAL_MS', 15_000),
    cexTransferCostBps: num('CEX_TRANSFER_COST_BPS', 15),

    telegramBotToken: optionalStr('TELEGRAM_BOT_TOKEN'),
    telegramChatId: optionalStr('TELEGRAM_CHAT_ID'),

    port: num('PORT', 3000),
    runOnce: process.argv.includes('--once'),
  };

  validate(config);
  return config;
}

function validate(c: ArboConfig): void {
  const problems: string[] = [];

  if (c.minTradeUsd <= 0) problems.push('MIN_TRADE_USD must be > 0');
  if (c.maxTradeUsd <= c.minTradeUsd) problems.push('MAX_TRADE_USD must exceed MIN_TRADE_USD');
  if (c.minProfitUsd < 0) problems.push('MIN_PROFIT_USD cannot be negative');
  if (c.slippageBps < 0 || c.slippageBps > 1_000) problems.push('SLIPPAGE_BPS must be between 0 and 1000');
  if (c.scanIntervalMs < 250) problems.push('SCAN_INTERVAL_MS below 250 will hammer your RPC into rate limits');
  if (c.gasLimitEstimate <= 0n) problems.push('GAS_LIMIT_ESTIMATE must be > 0');

  // The important gate: never let live mode start half-configured.
  if (c.mode === 'live') {
    if (!c.executorPrivateKey) {
      problems.push('MODE=live requires EXECUTOR_PRIVATE_KEY');
    } else if (!/^0x[0-9a-fA-F]{64}$/.test(c.executorPrivateKey)) {
      problems.push('EXECUTOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
    }

    const chainsWithoutContract = c.chains.filter((ch) => !c.contractAddresses[ch]);
    if (chainsWithoutContract.length > 0) {
      problems.push(
        `MODE=live requires a deployed flash-loan contract for every enabled chain. ` +
          `Missing: ${chainsWithoutContract.map((ch) => `ARB_CONTRACT_${ch.toUpperCase()}`).join(', ')}. ` +
          `Deploy with: npm run deploy:contract`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid ARBO configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/** True when the bot is permitted to broadcast transactions on this chain. */
export function canExecuteOnChain(c: ArboConfig, chain: ChainName): boolean {
  return (
    c.mode === 'live' && !c.killSwitch && !!c.executorPrivateKey && !!c.contractAddresses[chain]
  );
}
