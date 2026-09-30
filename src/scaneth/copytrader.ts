/**
 * SCANETH paper copytrader.
 *
 * Watches configured wallets and mirrors their DEX trades in paper mode:
 *   - When a watched wallet buys a token, simulate buying $20 USD worth.
 *   - When a watched wallet sells a token, simulate selling the same percentage
 *     of our paper position.
 *
 * Also tracks per-wallet PNL and sends a daily 12:00am MST ranking report of
 * best-to-worst copied wallets with $ and % PNL.
 *
 * No real transactions are sent. This is a simulation layer only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Contract, type Provider, type TransactionReceipt, type TransactionResponse } from 'ethers';
import { createLogger, errMeta } from '../logger';
import type { ScanethConfig } from '../config';
import type { ScanethNotifier } from './notifier';
import { fetchTokenPairs, pickBestPair } from './dexscreener';

const log = createLogger('scaneth:copytrader');

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();

const CHAINLINK_ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const CHAINLINK_FEED_ABI = ['function latestAnswer() view returns (int256)'];

/** ERC-20 Transfer(address,address,uint256) topic0. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** WETH Withdrawal(address,uint256) topic0 — emitted when WETH is unwrapped to ETH. */
const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/**
 * Auto-take-profit rule: positions bought ONLY by these wallets are exited at
 * the current mark once they are profitable and have been held >24h — they
 * no longer wait for the source wallet to exit.
 */
const AUTO_TP_WALLETS = new Set([
  '0xb51ff2f65b935142aab32abefa1c0e29a4161d31',
]);
const AUTO_TP_MIN_AGE_MS = 24 * 3_600_000;

/** Wallets whose buys are copied at a premium clip (strongest performers). */
const PREMIUM_WALLETS = new Set([
  '0xb51ff2f65b935142aab32abefa1c0e29a4161d31',
  '0xc05ef5e1fd014267f66fa24b260f361af7d79122',
]);
const PREMIUM_BUY_USD = 100;

/** Serialized paper position (bigint balance as string). */
export interface PersistedPosition {
  tokenAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: string;
  costBasisUsd: number;
  avgEntryPriceUsd: number;
  realizedPnlUsd: number;
  currentPriceUsd: number;
  openedAt: number;
  updatedAt: number;
  contributors: string[];
}

/** Full serializable paper-account state. */
export interface PersistedState {
  version: 1;
  savedAt: number;
  cashUsd: number;
  cumulativeRealizedUsd: number;
  tradeCount: number;
  premiumWallets: string[];
  positions: PersistedPosition[];
}

export interface PaperPosition {
  tokenAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Tokens still held in the paper wallet. */
  balance: bigint;
  /** Total USD spent on buys (cumulative). */
  costBasisUsd: number;
  /** Average entry price in USD. */
  avgEntryPriceUsd: number;
  /** Realized PNL in USD. */
  realizedPnlUsd: number;
  /** Latest market price in USD (DexScreener, refreshed periodically). */
  currentPriceUsd: number;
  /** First buy timestamp. */
  openedAt: number;
  /** Last activity timestamp. */
  updatedAt: number;
  /** Watched wallets that bought into this position (lowercase). */
  contributors: Set<string>;
}

interface WalletPosition {
  balance: bigint;
  costBasisUsd: number;
  avgEntryPriceUsd: number;
  /** Token decimals from the trade that created/updated this position. */
  decimals: number;
}

interface WalletDailyStats {
  realizedPnlUsd: number;
  costBasisUsd: number;
  trades: number;
}

export interface CopyTrade {
  wallet: string;
  type: 'buy' | 'sell';
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAmount: bigint;
  tokenDecimals: number;
  ethAmount: bigint;
  ethPriceUsd: number;
  tokenPriceUsd: number;
  /** For sells: percentage of the wallet's position that was sold. */
  sellPct?: number;
  /** For sells: average entry price of our paper position. */
  entryPriceUsd?: number;
  /** For sells: true when this sell closed the paper position entirely. */
  positionClosed?: boolean;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export interface CopyTraderStats {
  watchedWallets: string[];
  positionCount: number;
  buyAmountUsd: number;
  startingBudgetUsd: number;
  cashUsd: number;
  openPositionsValueUsd: number;
  equityUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  totalCostBasisUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  tradeCount: number;
}

export class CopyTrader {
  private readonly watchedWallets = new Set<string>();
  private readonly walletBalances = new Map<string, Map<string, bigint>>(); // wallet -> token -> balance
  private readonly walletPortfolios = new Map<string, Map<string, WalletPosition>>(); // wallet -> token -> position
  private readonly walletDailyStats = new Map<string, Map<string, WalletDailyStats>>(); // wallet -> day -> stats
  private readonly positions = new Map<string, PaperPosition>(); // token -> aggregated position
  private tradeCount = 0;
  /** All realized PNL since start, including closed/deleted positions. */
  private cumulativeRealizedUsd = 0;
  /** Trades observed per watched wallet (for scout ranking). */
  private readonly walletTradeCounts = new Map<string, number>();
  /** Remaining paper cash. Starts at the configured budget, decreases on buys, grows on sells. */
  private cashUsd: number;
  private ethUsdPrice = 0;
  private priceTimer?: NodeJS.Timeout;
  private reportTimer?: NodeJS.Timeout;
  private running = false;
  /**
   * Wallets copied at the premium $100 clip. Seeded with the proven
   * performers; the scout promotes proven newcomers and demotes degrading
   * wallets at each daily cycle.
   */
  private readonly premiumWallets = new Set(PREMIUM_WALLETS);
  /**
   * Buys whose token had no DexScreener pair yet at detection time. Sizing
   * them immediately would rely on a blind 18-decimal implied price — the
   * last corruption path behind 10^x PNL. They are retried every minute and
   * applied with market-anchored decimals once a pair lists.
   */
  private readonly pendingBuys = new Map<string, {
    wallet: string;
    tokenAddress: string;
    tokenAmount: bigint;
    ethAmount: bigint;
    ts: number;
    txHash: string;
    blockNumber: number;
    attempts: number;
    nextAt: number;
  }>();

  constructor(
    private readonly config: ScanethConfig,
    private readonly provider: Provider,
    private readonly notifier: ScanethNotifier,
  ) {
    for (const w of config.copytraderWatchedWallets) {
      this.watchedWallets.add(w.toLowerCase());
    }
    this.cashUsd = config.copytraderStartingBudgetUsd;
  }

  /** Open paper positions with full marking detail (for /positions). */
  getOpenPositions(): Array<{
    token: string;
    symbol: string;
    name: string;
    units: number;
    costBasisUsd: number;
    avgEntryUsd: number;
    currentPriceUsd: number;
    valueUsd: number;
    pnlUsd: number;
    openedAt: number;
  }> {
    return [...this.positions.values()].map((pos) => {
      const units = Number(pos.balance) / Math.pow(10, pos.decimals);
      const price = pos.currentPriceUsd > 0 ? pos.currentPriceUsd : pos.avgEntryPriceUsd;
      const value = units * price;
      return {
        token: pos.tokenAddress,
        symbol: pos.symbol,
        name: pos.name,
        units,
        costBasisUsd: Number(pos.costBasisUsd.toFixed(2)),
        avgEntryUsd: pos.avgEntryPriceUsd,
        currentPriceUsd: pos.currentPriceUsd,
        valueUsd: Number(value.toFixed(2)),
        pnlUsd: Number((value - pos.costBasisUsd).toFixed(2)),
        openedAt: pos.openedAt,
      };
    });
  }

  getStats(): CopyTraderStats {
    let totalCostBasis = 0;
    let totalUnrealized = 0;
    let openValue = 0;

    for (const pos of this.positions.values()) {
      totalCostBasis += pos.costBasisUsd;
      const price = pos.currentPriceUsd > 0 ? pos.currentPriceUsd : pos.avgEntryPriceUsd;
      const marketValue = (Number(pos.balance) / Math.pow(10, pos.decimals)) * price;
      openValue += marketValue;
      totalUnrealized += marketValue - pos.costBasisUsd;
    }

    // Paper equity = remaining cash + market value of open positions.
    // Total PNL is measured against the starting budget, exactly what the
    // account would show if these trades were real.
    const equity = this.cashUsd + openValue;
    const totalPnl = equity - this.config.copytraderStartingBudgetUsd;

    return {
      watchedWallets: [...this.watchedWallets],
      positionCount: this.positions.size,
      buyAmountUsd: this.config.copytraderBuyAmountUsd,
      startingBudgetUsd: this.config.copytraderStartingBudgetUsd,
      cashUsd: this.cashUsd,
      openPositionsValueUsd: openValue,
      equityUsd: equity,
      totalPnlUsd: totalPnl,
      totalPnlPct: this.config.copytraderStartingBudgetUsd > 0
        ? (totalPnl / this.config.copytraderStartingBudgetUsd) * 100
        : 0,
      totalCostBasisUsd: totalCostBasis,
      totalRealizedPnlUsd: this.cumulativeRealizedUsd,
      totalUnrealizedPnlUsd: totalUnrealized,
      tradeCount: this.tradeCount,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('paper copytrader started', {
      watchedWallets: this.watchedWallets.size,
      buyAmountUsd: this.config.copytraderBuyAmountUsd,
    });
    void this.restoreOrInit();
    void this.refreshEthPrice();
    this.scheduleDailyWalletReport();
  }

  /**
   * Restore persisted paper state from disk at boot. When no state file
   * exists yet, persist the fresh account immediately so every later restart
   * (deploy, crash) resumes exactly where the bot left off.
   */
  private async restoreOrInit(): Promise<void> {
    const path = this.config.copytraderStatePath;
    if (!path) return;
    try {
      const raw = await readFile(path, 'utf8');
      const state = JSON.parse(raw) as PersistedState;
      await this.restoreState(state);
      log.info('paper state restored from disk', {
        path,
        positions: this.positions.size,
        cashUsd: Number(this.cashUsd.toFixed(2)),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        log.warn('paper state load failed — starting fresh', { path, ...errMeta(err) });
      }
      await this.persistState();
    }
  }

  stop(): void {
    this.running = false;
    if (this.priceTimer) clearTimeout(this.priceTimer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
  }

  /** Serialize the full paper account for persistence or /dump. */
  serializeState(): PersistedState {
    return {
      version: 1,
      savedAt: Date.now(),
      cashUsd: this.cashUsd,
      cumulativeRealizedUsd: this.cumulativeRealizedUsd,
      tradeCount: this.tradeCount,
      premiumWallets: [...this.premiumWallets],
      positions: [...this.positions.values()].map((pos) => ({
        tokenAddress: pos.tokenAddress,
        name: pos.name,
        symbol: pos.symbol,
        decimals: pos.decimals,
        balance: pos.balance.toString(),
        costBasisUsd: pos.costBasisUsd,
        avgEntryPriceUsd: pos.avgEntryPriceUsd,
        realizedPnlUsd: pos.realizedPnlUsd,
        currentPriceUsd: pos.currentPriceUsd,
        openedAt: pos.openedAt,
        updatedAt: pos.updatedAt,
        contributors: [...pos.contributors],
      })),
    };
  }

  /** Write the paper account to disk (best-effort). */
  async persistState(): Promise<void> {
    const path = this.config.copytraderStatePath;
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(this.serializeState(), null, 2));
    } catch (err) {
      log.warn('paper state persist failed', { path, ...errMeta(err) });
    }
  }

  /** Apply a serialized paper account (from disk or a POST /restore payload). */
  async restoreState(state: PersistedState): Promise<void> {
    if (!state || state.version !== 1) {
      throw new Error('unsupported paper state payload (expected version 1)');
    }
    if (!Number.isFinite(state.cashUsd) || state.cashUsd < 0) {
      throw new Error('invalid cashUsd in paper state payload');
    }
    this.cashUsd = state.cashUsd;
    this.cumulativeRealizedUsd = Number.isFinite(state.cumulativeRealizedUsd) ? state.cumulativeRealizedUsd : 0;
    this.tradeCount = Number.isFinite(state.tradeCount) ? state.tradeCount : 0;
    if (Array.isArray(state.premiumWallets) && state.premiumWallets.length > 0) {
      this.premiumWallets.clear();
      for (const w of state.premiumWallets) this.premiumWallets.add(w.toLowerCase());
    }
    this.positions.clear();
    for (const p of state.positions ?? []) {
      const token = p.tokenAddress?.toLowerCase();
      if (!token || !token.startsWith('0x')) continue;
      let balance = 0n;
      try {
        balance = BigInt(p.balance);
      } catch {
        balance = 0n;
      }
      if (balance <= 0n) continue;
      let decimals = Number(p.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        decimals = await this.getDecimals(token);
      }
      const qty = Number(balance) / Math.pow(10, decimals);
      const avgEntry = qty > 0 && p.costBasisUsd > 0 ? p.costBasisUsd / qty : p.avgEntryPriceUsd;
      const pos: PaperPosition = {
        tokenAddress: token,
        name: p.name ?? 'Unknown',
        symbol: p.symbol ?? '???',
        decimals,
        balance,
        costBasisUsd: p.costBasisUsd,
        avgEntryPriceUsd: avgEntry > 0 ? avgEntry : p.avgEntryPriceUsd,
        realizedPnlUsd: Number.isFinite(p.realizedPnlUsd) ? p.realizedPnlUsd : 0,
        currentPriceUsd: Number.isFinite(p.currentPriceUsd) ? p.currentPriceUsd : 0,
        openedAt: p.openedAt ?? Date.now(),
        updatedAt: p.updatedAt ?? Date.now(),
        contributors: new Set((p.contributors ?? []).map((w) => w.toLowerCase())),
      };
      this.positions.set(token, pos);
      await this.seedWalletTrackingFromChain(token, pos);
    }
    await this.persistState();
  }

  /**
   * Seed proportional-sell tracking from the chain: for each contributor of a
   * restored position, use their real on-chain token balance as the wallet
   * position a future sell percentage is computed against.
   */
  private async seedWalletTrackingFromChain(token: string, pos: PaperPosition): Promise<void> {
    for (const wallet of pos.contributors) {
      try {
        const contract = new Contract(token, ['function balanceOf(address) view returns (uint256)'], this.provider);
        const bal = (await contract['balanceOf']!(wallet)) as bigint;
        if (bal <= 0n) continue;
        this.getWalletBalanceMap(wallet).set(token, bal);
        const walletKey = wallet.toLowerCase();
        let portfolio = this.walletPortfolios.get(walletKey);
        if (!portfolio) {
          portfolio = new Map<string, WalletPosition>();
          this.walletPortfolios.set(walletKey, portfolio);
        }
        const qty = Number(bal) / Math.pow(10, pos.decimals);
        portfolio.set(token, {
          balance: bal,
          costBasisUsd: qty * pos.avgEntryPriceUsd,
          avgEntryPriceUsd: pos.avgEntryPriceUsd,
          decimals: pos.decimals,
        });
      } catch (err) {
        log.debug('wallet tracking seed failed', { token, wallet, ...errMeta(err) });
      }
    }
  }

  /**
   * Force-exit an open paper position at the current market price (manual
   * exit / admin action). Refreshes the mark first so the exit uses a fresh
   * price rather than one up to 60s old.
   */
  async exitToken(tokenAddress: string, reason = 'manual'): Promise<boolean> {
    const key = tokenAddress.toLowerCase();
    const pos = this.positions.get(key);
    if (!pos || pos.balance <= 0n) return false;

    let price = await this.getCurrentTokenPrice(key);
    if (!(price > 0)) price = pos.currentPriceUsd;
    if (!(price > 0)) {
      log.warn('manual exit skipped — no market price', { token: key });
      return false;
    }

    const qty = Number(pos.balance) / Math.pow(10, pos.decimals);
    const proceedsUsd = qty * price;
    const pnlUsd = proceedsUsd - pos.costBasisUsd;
    const capitalBefore = this.paperEquity();

    pos.balance = 0n;
    pos.realizedPnlUsd += pnlUsd;
    this.cumulativeRealizedUsd += pnlUsd;
    pos.costBasisUsd = 0;
    pos.updatedAt = Date.now();
    this.cashUsd += proceedsUsd;
    this.positions.delete(key);

    log.warn('manual exit executed', {
      token: pos.symbol,
      entry: pos.avgEntryPriceUsd,
      exit: price,
      proceedsUsd,
      pnlUsd,
      reason,
    });

    await this.sendManualExitAlert(pos, proceedsUsd, pnlUsd, capitalBefore);
    await this.persistState();
    return true;
  }

  /** Alert for a manual/admin exit (minimal format). */
  private async sendManualExitAlert(
    pos: PaperPosition,
    proceedsUsd: number,
    pnlUsd: number,
    capitalBefore: number,
  ): Promise<void> {
    const pnlPct = (pnlUsd / Math.max(1e-9, proceedsUsd - pnlUsd)) * 100;
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const endingCapital = this.paperEquity();
    const wallets =
      pos.contributors.size > 0
        ? [...pos.contributors].map((w) => `<code>${w}</code>`).join(', ')
        : '(manual exit)';

    const lines = [
      `<b>SCANETH — Paper copytrade SELL (manual exit)</b>`,
      '',
      `Token: <code>${pos.tokenAddress}</code>`,
      `Copied wallet: ${wallets}`,
      '',
      `PNL: <b>${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)</b>`,
      `Capital before trade: $${capitalBefore.toFixed(2)}`,
      `Capital after trade: <b>$${endingCapital.toFixed(2)}</b>`,
      '',
      `✋ Exited manually at market`,
    ];

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('manual exit alert failed', { token: pos.tokenAddress });
    }
  }

  /** Wipe the paper account back to the starting budget (admin action). */
  async resetPaperAccount(): Promise<void> {
    this.positions.clear();
    this.walletBalances.clear();
    this.walletPortfolios.clear();
    this.walletDailyStats.clear();
    this.walletTradeCounts.clear();
    this.cashUsd = this.config.copytraderStartingBudgetUsd;
    this.cumulativeRealizedUsd = 0;
    this.tradeCount = 0;
    this.premiumWallets.clear();
    for (const w of PREMIUM_WALLETS) this.premiumWallets.add(w);
    await this.persistState();
    log.warn('paper account reset to starting budget');
  }

  /** Inspect all transactions in a block for watched-wallet activity. */
  async processBlock(blockNumber: number): Promise<void> {
    if (this.watchedWallets.size === 0) return;

    try {
      const block = await this.provider.getBlock(blockNumber, true);
      if (!block) return;

      const trades: CopyTrade[] = [];

      for (const tx of block.prefetchedTransactions) {
        const from = tx.from?.toLowerCase();
        if (!from || !this.watchedWallets.has(from)) continue;

        try {
          const receipt = await this.provider.getTransactionReceipt(tx.hash);
          if (!receipt || receipt.status !== 1) continue;

          const trade = await this.parseTrade(tx, receipt, from);
          if (trade) trades.push(trade);
        } catch (err) {
          log.debug('copytrade inspection failed', { txHash: tx.hash, ...errMeta(err) });
        }
      }

      // Execute every detected trade — no duplicate-token filtering.
      for (const trade of trades) {
        await this.executePaperTrade(trade);
      }
    } catch (err) {
      log.error('copytrader block scan failed', { blockNumber, ...errMeta(err) });
    }
  }

  private scheduleDailyWalletReport(): void {
    if (!this.running) return;
    const next = nextUtcOccurrence(this.config.dailyReportHourUtc, 0);
    const msUntil = next.getTime() - Date.now();
    log.debug('next wallet ranking report scheduled', { at: next.toISOString(), msUntil });
    this.reportTimer = setTimeout(() => {
      void this.sendDailyWalletReport();
      this.scheduleDailyWalletReport();
    }, Math.max(1_000, msUntil));
  }

  private async sendDailyWalletReport(): Promise<void> {
    const previousDay = previousMstDay(this.config.dailyReportHourUtc);
    const walletPnls: Array<{ wallet: string; realizedUsd: number; unrealizedUsd: number; totalPnlUsd: number; pnlPct: number; trades: number; investedUsd: number }> = [];

    for (const wallet of this.watchedWallets) {
      const dayStats = this.getWalletDayStats(wallet, previousDay);
      const portfolio = this.walletPortfolios.get(wallet);

      let unrealizedUsd = 0;
      let openCostBasisUsd = 0;

      if (portfolio) {
        for (const [tokenLower, pos] of portfolio) {
          if (pos.balance <= 0n) continue;
          const currentPrice = await this.getCurrentTokenPrice(tokenLower);
          if (!Number.isFinite(currentPrice) || currentPrice <= 0) continue;
          const tokenQty = Number(pos.balance) / Math.pow(10, pos.decimals || 18);
          const marketValue = tokenQty * currentPrice;
          const cost = tokenQty * pos.avgEntryPriceUsd;
          unrealizedUsd += marketValue - cost;
          openCostBasisUsd += cost;
        }
      }

      const totalPnlUsd = dayStats.realizedPnlUsd + unrealizedUsd;
      const invested = dayStats.costBasisUsd + openCostBasisUsd;
      const pnlPct = invested > 0 ? (totalPnlUsd / invested) * 100 : 0;

      walletPnls.push({
        wallet,
        realizedUsd: dayStats.realizedPnlUsd,
        unrealizedUsd,
        totalPnlUsd,
        pnlPct,
        trades: dayStats.trades,
        investedUsd: invested,
      });
    }

    walletPnls.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

    // Day totals: all copied trades combined into one PNL figure.
    const dayTotalPnlUsd = walletPnls.reduce((sum, w) => sum + w.totalPnlUsd, 0);
    const dayInvestedUsd = walletPnls.reduce((sum, w) => sum + w.investedUsd, 0);
    const dayTotalPnlPct = dayInvestedUsd > 0 ? (dayTotalPnlUsd / dayInvestedUsd) * 100 : 0;
    const dayTrades = walletPnls.reduce((sum, w) => sum + w.trades, 0);

    if (walletPnls.length === 0) {
      const message =
        `<b>SCANETH — Copied wallet rankings (${previousDay})</b>\n\n` +
        `No wallets are being copied yet.`;
      await this.notifier.sendRaw(message);
      return;
    }

    const lines = walletPnls.map((w, idx) => {
      const sign = w.totalPnlUsd >= 0 ? '+' : '';
      const pctSign = w.pnlPct >= 0 ? '+' : '';
      const emoji = w.totalPnlUsd >= 0 ? '🟢' : '🔴';
      return (
        `${idx + 1}. ${emoji} <code>${w.wallet}</code>\n` +
        `   PNL: <b>${sign}$${w.totalPnlUsd.toFixed(2)} (${pctSign}${w.pnlPct.toFixed(2)}%)</b> · Trades: ${w.trades}`
      );
    });

    // Cut list: wallets with negative PNL for the day, worst first.
    const cutCandidates = [...walletPnls].reverse().filter((w) => w.totalPnlUsd < 0);
    let cutSection = '';
    if (cutCandidates.length > 0) {
      cutSection =
        `\n\n<b>✂️ Cut candidates (negative PNL — scout will replace):</b>\n` +
        cutCandidates.map((w) => `<code>${w.wallet}</code> (${w.totalPnlUsd.toFixed(2)})`).join('\n');
    }

    const dayTotalsSign = dayTotalPnlUsd >= 0 ? '+' : '';
    const dayTotalsPctSign = dayTotalPnlPct >= 0 ? '+' : '';
    const dayTotalsSection =
      `\n\n<b>📊 Day totals (all trades combined)</b>\n` +
      `PNL: <b>${dayTotalsSign}$${dayTotalPnlUsd.toFixed(2)} (${dayTotalsPctSign}${dayTotalPnlPct.toFixed(2)}%)</b>\n` +
      `Trades copied: ${dayTrades}`;

    const message =
      `<b>SCANETH — Copied wallet rankings (${previousDay})</b>\n\n` +
      lines.join('\n\n') +
      cutSection +
      dayTotalsSection;

    const ok = await this.notifier.sendRaw(message);
    if (ok) {
      log.info('wallet ranking report sent', { previousDay, wallets: walletPnls.length });
    }
  }

  private async refreshEthPrice(): Promise<void> {
    if (!this.running) return;

    try {
      const feed = new Contract(CHAINLINK_ETH_USD_FEED, CHAINLINK_FEED_ABI, this.provider);
      const answer = await (feed.latestAnswer as () => Promise<bigint>)();
      this.ethUsdPrice = Number(answer) / 1e8;
      log.debug('ETH/USD price refreshed', { price: this.ethUsdPrice });
    } catch (err) {
      log.debug('ETH/USD price refresh failed', errMeta(err));
    }

    // Mark open paper positions to market so unrealized PNL reflects reality.
    await this.refreshPositionPrices();

    // Apply deferred buys whose tokens have listed a market pair by now.
    await this.retryPendingBuys();

    // Exit stale profitable positions from the auto-take-profit wallets.
    await this.enforceAutoTakeProfit();

    // Auto-exit positions that have dropped past the stop-loss threshold.
    await this.enforceStopLoss();

    // Persist marks/trades so restarts (deploy or crash) resume exactly here.
    await this.persistState();

    this.priceTimer = setTimeout(() => void this.refreshEthPrice(), 60_000);
  }

  /**
   * Auto-sell any open position trading below entry by the stop-loss percent.
   * Runs after every mark-to-market cycle (every 60s). Disabled at 0. This is
   * the capital-protection backstop: dead/rug tokens are cut at a known,
   * bounded loss instead of riding to zero waiting for a wallet exit that
   * never comes.
   */
  private async enforceStopLoss(): Promise<void> {
    const stopPct = this.config.copytraderStopLossPct;
    if (stopPct <= 0) return;

    for (const [key, pos] of [...this.positions]) {
      if (pos.balance <= 0n) continue;
      const price = pos.currentPriceUsd;
      if (!(price > 0) || !(pos.avgEntryPriceUsd > 0)) continue;
      const dropPct = ((price - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
      if (dropPct > -stopPct) continue;

      const qty = Number(pos.balance) / Math.pow(10, pos.decimals);
      const proceedsUsd = qty * price;
      const pnlUsd = proceedsUsd - pos.costBasisUsd;
      const capitalBefore = this.paperEquity();

      pos.balance = 0n;
      pos.realizedPnlUsd += pnlUsd;
      this.cumulativeRealizedUsd += pnlUsd;
      pos.costBasisUsd = 0;
      pos.updatedAt = Date.now();
      this.cashUsd += proceedsUsd;
      this.positions.delete(key);

      log.warn('stop-loss triggered', {
        token: pos.symbol,
        entry: pos.avgEntryPriceUsd,
        exit: price,
        dropPct,
        proceedsUsd,
        pnlUsd,
      });

      await this.sendStopLossAlert(pos, proceedsUsd, pnlUsd, capitalBefore);
    }
  }

  /** Alert for a stop-loss exit of a paper position (minimal format). */
  private async sendStopLossAlert(
    pos: PaperPosition,
    proceedsUsd: number,
    pnlUsd: number,
    capitalBefore: number,
  ): Promise<void> {
    const costBasisSold = Math.max(1e-9, proceedsUsd - pnlUsd);
    const pnlPct = (pnlUsd / costBasisSold) * 100;
    const endingCapital = this.paperEquity();

    const lines = [
      `<b>SCANETH — Paper copytrade SELL (stop-loss)</b>`,
      '',
      `Token: <code>${pos.tokenAddress}</code>`,
      '',
      `PNL: <b>-$${Math.abs(pnlUsd).toFixed(2)} (-${Math.abs(pnlPct).toFixed(2)}%)</b>`,
      `Capital before trade: $${capitalBefore.toFixed(2)}`,
      `Capital after trade: <b>$${endingCapital.toFixed(2)}</b>`,
      '',
      `⛔ Auto-exited at −${this.config.copytraderStopLossPct}% stop-loss`,
    ];

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('stop-loss alert failed', { token: pos.tokenAddress });
    }
  }

  /**
   * Positions bought ONLY by the AUTO_TP_WALLETS wallets are exited at the
   * current mark once profitable and held >24h, instead of waiting for a
   * source-wallet exit that may never come. Runs after every mark-to-market
   * cycle. Positions shared with any other watched wallet are left alone.
   */
  private async enforceAutoTakeProfit(): Promise<void> {
    for (const [key, pos] of [...this.positions]) {
      if (pos.balance <= 0n || pos.contributors.size === 0) continue;
      if (![...pos.contributors].every((w) => AUTO_TP_WALLETS.has(w))) continue;
      if (Date.now() - pos.openedAt < AUTO_TP_MIN_AGE_MS) continue;

      const price = pos.currentPriceUsd;
      if (!(price > 0) || !(pos.avgEntryPriceUsd > 0)) continue;
      if (price <= pos.avgEntryPriceUsd) continue; // only profitable exits

      const qty = Number(pos.balance) / Math.pow(10, pos.decimals);
      const proceedsUsd = qty * price;
      const pnlUsd = proceedsUsd - pos.costBasisUsd;
      const capitalBefore = this.paperEquity();

      pos.balance = 0n;
      pos.realizedPnlUsd += pnlUsd;
      this.cumulativeRealizedUsd += pnlUsd;
      pos.costBasisUsd = 0;
      pos.updatedAt = Date.now();
      this.cashUsd += proceedsUsd;
      this.positions.delete(key);

      log.info('auto-take-profit exit', {
        token: pos.symbol,
        entry: pos.avgEntryPriceUsd,
        exit: price,
        proceedsUsd,
        pnlUsd,
        heldHours: ((Date.now() - pos.openedAt) / 3_600_000).toFixed(1),
      });

      await this.sendAutoTpAlert(pos, proceedsUsd, pnlUsd, capitalBefore);
    }
  }

  /** Alert for an auto-take-profit exit (same minimal format as wallet sells). */
  private async sendAutoTpAlert(
    pos: PaperPosition,
    proceedsUsd: number,
    pnlUsd: number,
    capitalBefore: number,
  ): Promise<void> {
    const pnlPct = (pnlUsd / Math.max(1e-9, proceedsUsd - pnlUsd)) * 100;
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const endingCapital = this.paperEquity();

    const lines = [
      `<b>SCANETH — Paper copytrade SELL (auto-take-profit)</b>`,
      '',
      `Token: <code>${pos.tokenAddress}</code>`,
      '',
      `PNL: <b>${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)</b>`,
      `Capital before trade: $${capitalBefore.toFixed(2)}`,
      `Capital after trade: <b>$${endingCapital.toFixed(2)}</b>`,
      '',
      `📌 Exited: profitable and held >24h (wallet rule)`,
    ];

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('auto-take-profit alert failed', { token: pos.tokenAddress });
    }
  }

  private schedulePendingBuy(
    wallet: string,
    tokenAddress: string,
    tokenAmount: bigint,
    ethAmount: bigint,
    tx: TransactionResponse,
  ): void {
    if (this.pendingBuys.has(tokenAddress)) return;
    this.pendingBuys.set(tokenAddress, {
      wallet,
      tokenAddress,
      tokenAmount,
      ethAmount,
      ts: Date.now(),
      txHash: tx.hash,
      blockNumber: tx.blockNumber ?? 0,
      attempts: 0,
      nextAt: 0,
    });
    log.info('paper buy deferred — no market pair yet, will retry', { token: tokenAddress, wallet, txHash: tx.hash });
  }

  /**
   * Retry deferred buys once a DexScreener pair exists. Decimals are anchored
   * to the live market price (search 0-18 for the implied price closest to
   * the market price), then the buy applies at the trade's own implied price.
   */
  private async retryPendingBuys(): Promise<void> {
    if (this.pendingBuys.size === 0 || !this.running) return;
    const now = Date.now();

    for (const [tokenAddress, item] of [...this.pendingBuys]) {
      if (item.nextAt > now) continue;
      this.pendingBuys.delete(tokenAddress);

      const dexPrice = await this.getCurrentTokenPrice(tokenAddress);
      if (!(dexPrice > 0)) {
        item.attempts++;
        if (item.attempts >= 30) {
          log.info('deferred paper buy dropped — no market pair after 30 min', { token: tokenAddress });
          continue;
        }
        item.nextAt = now + 60_000;
        this.pendingBuys.set(tokenAddress, item);
        continue;
      }

      const ethPriceUsd = this.ethUsdPrice || 2500;
      const impliedPrice = (d: number): number => {
        const qty = Number(item.tokenAmount) / Math.pow(10, d);
        if (!(qty > 0)) return NaN;
        return (Number(item.ethAmount) * ethPriceUsd) / qty;
      };
      let best = 18;
      let bestOff = Infinity;
      for (let d = 0; d <= 18; d++) {
        const p = impliedPrice(d);
        if (!Number.isFinite(p) || p <= 0) continue;
        const off = Math.abs(Math.log10(p / dexPrice));
        if (off < bestOff) {
          bestOff = off;
          best = d;
        }
      }
      const price = impliedPrice(best);
      if (!Number.isFinite(price) || price <= 0) continue;

      log.info('deferred paper buy applied — market pair now live', {
        token: tokenAddress,
        wallet: item.wallet,
        attempt: item.attempts + 1,
        decimals: best,
        price,
      });

      const trade = await this.buildTrade(
        item.wallet, 'buy', tokenAddress, best, item.tokenAmount,
        item.ethAmount, ethPriceUsd, price,
        { hash: item.txHash, blockNumber: item.blockNumber } as TransactionResponse,
      );
      trade.timestamp = item.ts;
      await this.executePaperTrade(trade);
    }
  }

  /** Paper equity: remaining cash + market value of open positions. */
  private paperEquity(): number {
    let openValue = 0;
    for (const pos of this.positions.values()) {
      const price = pos.currentPriceUsd > 0 ? pos.currentPriceUsd : pos.avgEntryPriceUsd;
      openValue += (Number(pos.balance) / Math.pow(10, pos.decimals)) * price;
    }
    return this.cashUsd + openValue;
  }

  /** Refresh current prices of open paper positions via DexScreener. */
  private async refreshPositionPrices(): Promise<void> {
    if (this.positions.size === 0) return;

    const entries = [...this.positions.entries()];
    // DexScreener supports up to 30 comma-separated addresses per request.
    for (let i = 0; i < entries.length; i += 30) {
      const batch = entries.slice(i, i + 30);
      const query = batch.map(([token]) => token).join(',');
      try {
        const pairs = await fetchTokenPairs(query);
        for (const [token, pos] of batch) {
          const best = pickBestPair(pairs, token);
          if (best?.priceUsd) {
            const price = parseFloat(best.priceUsd);
            if (Number.isFinite(price) && price > 0) {
              pos.currentPriceUsd = price;
            }
          }
        }
      } catch (err) {
        log.debug('position price refresh failed', { query, ...errMeta(err) });
      }
    }
  }

  /**
   * Detect a buy/sell from ERC-20 Transfer events in the transaction receipt.
   *
   * This works for ANY router or aggregator (Uniswap V2/V3/Universal Router,
   * 1inch, LiFi, custom trading bots, EIP-7702 delegated calls) because every
   * DEX swap emits Transfer events touching the trader's wallet:
   *   Buy:  wallet receives a non-WETH token and pays ETH (msg.value) or WETH.
   *   Sell: wallet sends a non-WETH token and receives WETH, or the router
   *         unwraps WETH to native ETH for the wallet.
   */
  private async parseTrade(
    tx: TransactionResponse,
    receipt: TransactionReceipt,
    wallet: string,
  ): Promise<CopyTrade | null> {
    const tokenIn = new Map<string, bigint>();
    const tokenOut = new Map<string, bigint>();
    let wethIn = 0n;
    let wethOut = 0n;
    let ethUnwrapped = 0n;

    for (const lg of receipt.logs) {
      const topic0 = lg.topics[0];
      if (topic0 === TRANSFER_TOPIC && lg.topics.length >= 3) {
        const topic1 = lg.topics[1];
        const topic2 = lg.topics[2];
        if (!topic1 || !topic2) continue;
        const from = '0x' + topic1.slice(26);
        const to = '0x' + topic2.slice(26);
        let amount: bigint;
        try {
          amount = BigInt(lg.data);
        } catch {
          continue;
        }
        if (amount === 0n || from === to) continue;
        const token = lg.address.toLowerCase();
        if (token === WETH) {
          if (to === wallet) wethIn += amount;
          else if (from === wallet) wethOut += amount;
        } else if (to === wallet) {
          tokenIn.set(token, (tokenIn.get(token) ?? 0n) + amount);
        } else if (from === wallet) {
          tokenOut.set(token, (tokenOut.get(token) ?? 0n) + amount);
        }
      } else if (topic0 === WETH_WITHDRAWAL_TOPIC && lg.address.toLowerCase() === WETH) {
        try {
          ethUnwrapped += BigInt(lg.data);
        } catch {
          // ignore malformed data
        }
      }
    }

    const ethPriceUsd = this.ethUsdPrice || 2500;

    // Buy: wallet paid ETH or WETH and received a non-WETH token.
    const bought = [...tokenIn.entries()][0];
    if (bought && (tx.value > 0n || wethOut > 0n)) {
      const [tokenAddress, tokenAmount] = bought;
      const ethAmount = tx.value + wethOut;
      if (tokenAmount <= 0n) return null;
      const { decimals, tokenPriceUsd, anchored } = await this.resolveDecimalsAndPrice(tokenAddress, tokenAmount, ethAmount, ethPriceUsd);
      if (!anchored) {
        // No market pair yet — sizing now would rely on a blind implied price.
        this.schedulePendingBuy(wallet, tokenAddress, tokenAmount, ethAmount, tx);
        return null;
      }
      if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) return null;
      return this.buildTrade(wallet, 'buy', tokenAddress, decimals, tokenAmount, ethAmount, ethPriceUsd, tokenPriceUsd, tx);
    }

    // Sell: wallet sent a non-WETH token in a swap (received WETH, another
    // token back, or the router unwrapped WETH to native ETH for it).
    const sold = [...tokenOut.entries()][0];
    if (sold && (wethIn > 0n || ethUnwrapped > 0n || tokenIn.size > 0)) {
      const [tokenAddress, tokenAmount] = sold;
      if (tokenAmount <= 0n) return null;
      const ethAmount = wethIn > 0n ? wethIn : ethUnwrapped;
      let decimals: number;
      let tokenPriceUsd: number;
      if (ethAmount > 0n) {
        ({ decimals, tokenPriceUsd } = await this.resolveDecimalsAndPrice(tokenAddress, tokenAmount, ethAmount, ethPriceUsd));
      } else {
        decimals = await this.getDecimals(tokenAddress);
        tokenPriceUsd = await this.getCurrentTokenPrice(tokenAddress);
      }
      if (!Number.isFinite(tokenPriceUsd) || tokenPriceUsd <= 0) return null;
      return this.buildTrade(wallet, 'sell', tokenAddress, decimals, tokenAmount, ethAmount, ethPriceUsd, tokenPriceUsd, tx);
    }

    return null;
  }

  private async buildTrade(
    wallet: string,
    type: 'buy' | 'sell',
    tokenAddress: string,
    tokenDecimals: number,
    tokenAmount: bigint,
    ethAmount: bigint,
    ethPriceUsd: number,
    tokenPriceUsd: number,
    tx: TransactionResponse,
  ): Promise<CopyTrade> {
    return {
      wallet,
      type,
      tokenAddress,
      tokenName: await this.getName(tokenAddress),
      tokenSymbol: await this.getSymbol(tokenAddress),
      tokenAmount,
      tokenDecimals,
      ethAmount,
      ethPriceUsd,
      tokenPriceUsd,
      txHash: tx.hash,
      blockNumber: tx.blockNumber ?? 0,
      timestamp: Date.now(),
    };
  }

  private async executePaperTrade(trade: CopyTrade): Promise<void> {
    this.tradeCount++;
    const wKey = trade.wallet.toLowerCase();
    this.walletTradeCounts.set(wKey, (this.walletTradeCounts.get(wKey) ?? 0) + 1);
    this.getWalletDayStats(trade.wallet, currentMstDay()).trades++;
    if (trade.type === 'buy') {
      await this.executePaperBuy(trade);
    } else {
      await this.executePaperSell(trade);
    }
  }

  /** Add a wallet to the watched set (scout engine). Returns false if already watched. */
  addWatchedWallet(wallet: string): boolean {
    const key = wallet.toLowerCase();
    if (this.watchedWallets.has(key)) return false;
    this.watchedWallets.add(key);
    log.info('scout added wallet', { wallet: key });
    return true;
  }

  /** Remove a wallet from the watched set (scout engine). */
  removeWatchedWallet(wallet: string): boolean {
    const key = wallet.toLowerCase();
    if (!this.watchedWallets.has(key)) return false;
    this.watchedWallets.delete(key);
    this.premiumWallets.delete(key);
    log.info('scout removed wallet', { wallet: key });
    return true;
  }

  /** Premium ($100-clip) wallets — scout promotes/demotes based on proof. */
  isPremiumWallet(wallet: string): boolean {
    return this.premiumWallets.has(wallet.toLowerCase());
  }

  /** Promote a proven wallet to $100 clips. Returns false if already premium. */
  promoteWallet(wallet: string): boolean {
    const key = wallet.toLowerCase();
    if (!this.watchedWallets.has(key) || this.premiumWallets.has(key)) return false;
    this.premiumWallets.add(key);
    log.info('wallet promoted to premium clips', { wallet: key });
    return true;
  }

  /** Demote a degrading wallet back to $20 clips. Returns false if not premium. */
  demoteWallet(wallet: string): boolean {
    const key = wallet.toLowerCase();
    if (!this.premiumWallets.delete(key)) return false;
    log.info('wallet demoted to default clips', { wallet: key });
    return true;
  }

  getPremiumWallets(): string[] {
    return [...this.premiumWallets];
  }

  /** Per-wallet performance across all observed trades (for scout ranking). */
  getWalletPerformance(): Map<string, { realizedPnlUsd: number; unrealizedPnlUsd: number; trades: number }> {
    const result = new Map<string, { realizedPnlUsd: number; unrealizedPnlUsd: number; trades: number }>();
    for (const wallet of this.watchedWallets) {
      let realized = 0;
      const days = this.walletDailyStats.get(wallet);
      if (days) {
        for (const stats of days.values()) realized += stats.realizedPnlUsd;
      }

      let unrealized = 0;
      const portfolio = this.walletPortfolios.get(wallet);
      if (portfolio) {
        for (const [token, pos] of portfolio) {
          if (pos.balance <= 0n) continue;
          const live = this.positions.get(token);
          const price = live && live.currentPriceUsd > 0 ? live.currentPriceUsd : pos.avgEntryPriceUsd;
          unrealized += (Number(pos.balance) / Math.pow(10, pos.decimals || 18)) * (price - pos.avgEntryPriceUsd);
        }
      }

      result.set(wallet, {
        realizedPnlUsd: realized,
        unrealizedPnlUsd: unrealized,
        trades: this.walletTradeCounts.get(wallet) ?? 0,
      });
    }
    return result;
  }

  private async executePaperBuy(trade: CopyTrade): Promise<void> {
    const key = trade.tokenAddress.toLowerCase();

    // Track the watched wallet's own balance/portfolio for EVERY detected buy,
    // whether or not we mirror it (needed for proportional sell sizing).
    const walletBalances = this.getWalletBalanceMap(trade.wallet);
    const prevBalance = walletBalances.get(key) ?? 0n;
    walletBalances.set(key, prevBalance + trade.tokenAmount);
    this.updateWalletPortfolioBuy(trade.wallet, trade.tokenAddress, trade.tokenAmount, trade.tokenDecimals, trade.tokenPriceUsd);

    /**
     * Per-wallet buy sizing: premium wallets (see PREMIUM_WALLETS) are copied
     * at a premium clip. All other wallets use the default.
     */
    const buyAmountUsd = this.premiumWallets.has(trade.wallet.toLowerCase())
      ? PREMIUM_BUY_USD
      : this.config.copytraderBuyAmountUsd;

    // Respect the paper cash budget.
    if (this.cashUsd < buyAmountUsd) {
      log.debug('paper buy skipped — out of cash', { token: trade.tokenAddress, cashUsd: this.cashUsd });
      return;
    }

    // Update paper position. Every position lives on ONE decimal scale:
    // re-derive the token quantity in the position's stored scale instead of
    // the trade's freshly-resolved decimals, which can differ per transaction
    // and would otherwise corrupt the PNL math by 10^x.
    let pos = this.positions.get(key);
    const positionDecimals = pos ? pos.decimals : trade.tokenDecimals;
    const tokenQty = buyAmountUsd / trade.tokenPriceUsd;
    const tokenAmountBigInt = BigInt(Math.floor(tokenQty * Math.pow(10, positionDecimals)));

    if (tokenAmountBigInt <= 0n) {
      log.debug('paper buy too small', { token: trade.tokenAddress, price: trade.tokenPriceUsd });
      return;
    }

    if (!pos) {
      pos = {
        tokenAddress: trade.tokenAddress,
        name: trade.tokenName,
        symbol: trade.tokenSymbol,
        decimals: positionDecimals,
        balance: 0n,
        costBasisUsd: 0,
        avgEntryPriceUsd: 0,
        realizedPnlUsd: 0,
        currentPriceUsd: trade.tokenPriceUsd,
        openedAt: trade.timestamp,
        updatedAt: trade.timestamp,
        contributors: new Set([trade.wallet.toLowerCase()]),
      };
      this.positions.set(key, pos);
    } else {
      pos.contributors.add(trade.wallet.toLowerCase());
    }

    const newCost = pos.costBasisUsd + buyAmountUsd;
    const newBalance = pos.balance + tokenAmountBigInt;
    pos.avgEntryPriceUsd = newCost / (Number(newBalance) / Math.pow(10, positionDecimals));
    pos.costBasisUsd = newCost;
    pos.balance = newBalance;
    pos.currentPriceUsd = trade.tokenPriceUsd;
    pos.updatedAt = trade.timestamp;

    // Deduct from the paper cash budget.
    this.cashUsd -= buyAmountUsd;

    // Track daily cost basis for the wallet.
    const day = currentMstDay();
    const dayStats = this.getWalletDayStats(trade.wallet, day);
    dayStats.costBasisUsd += buyAmountUsd;

    log.info('paper buy executed', {
      wallet: trade.wallet,
      token: trade.tokenSymbol,
      amountUsd: buyAmountUsd,
      tokenAmount: tokenAmountBigInt.toString(),
    });

    // No alert on buys — the single trade alert fires when the position is sold.
  }

  private async executePaperSell(trade: CopyTrade): Promise<void> {
    const key = trade.tokenAddress.toLowerCase();

    // Track the watched wallet's own balance for EVERY detected sell.
    const walletBalances = this.getWalletBalanceMap(trade.wallet);
    const walletBalanceBefore = walletBalances.get(key) ?? 0n;
    walletBalances.set(key, walletBalanceBefore > trade.tokenAmount ? walletBalanceBefore - trade.tokenAmount : 0n);

    const pos = this.positions.get(key);
    if (!pos || pos.balance <= 0n) {
      log.debug('paper sell ignored — no position', { token: trade.tokenAddress });
      return;
    }

    // Account snapshot before the trade (for the alert).
    const capitalBefore = this.paperEquity();

    // Any watched wallet's exit counts: mirror the fraction of THEIR
    // position that they sold, applied to our aggregated position.
    const sellPct = walletBalanceBefore > 0n ? Math.min(1, Number(trade.tokenAmount) / Number(walletBalanceBefore)) : 1;
    const ourSellAmount = BigInt(Math.floor(Number(pos.balance) * sellPct));

    if (ourSellAmount <= 0n) {
      log.debug('paper sell too small', { token: trade.tokenAddress });
      return;
    }

    // Quantities MUST use the position's stored decimals — the trade's
    // freshly-resolved decimals can differ per transaction and would scale
    // the PNL by 10^x.
    const qtySold = Number(ourSellAmount) / Math.pow(10, pos.decimals);

    // Guard against a bogus sell-time price: if it deviates from the live
    // mark price by >~30x, the sell-side decimals/price resolution failed —
    // fall back to the mark price (refreshed from DexScreener every 60s).
    let sellPriceUsd = trade.tokenPriceUsd;
    if (pos.currentPriceUsd > 0 && Number.isFinite(sellPriceUsd) && sellPriceUsd > 0) {
      const offBy = Math.abs(Math.log10(sellPriceUsd / pos.currentPriceUsd));
      if (Number.isFinite(offBy) && offBy > 1.5) {
        log.warn('sell price deviates from mark — using mark price', {
          token: trade.tokenAddress,
          tradePrice: sellPriceUsd,
          markPrice: pos.currentPriceUsd,
        });
        sellPriceUsd = pos.currentPriceUsd;
      }
    }

    const proceedsUsd = qtySold * sellPriceUsd;
    const costBasisSold = qtySold * pos.avgEntryPriceUsd;
    const pnlUsd = proceedsUsd - costBasisSold;

    pos.balance -= ourSellAmount;
    pos.realizedPnlUsd += pnlUsd;
    this.cumulativeRealizedUsd += pnlUsd;
    pos.costBasisUsd = Math.max(0, pos.costBasisUsd - costBasisSold);
    pos.currentPriceUsd = trade.tokenPriceUsd;
    pos.updatedAt = trade.timestamp;

    // Credit sale proceeds back to the paper cash budget.
    this.cashUsd += proceedsUsd;

    // Update wallet portfolio.
    this.updateWalletPortfolioSell(trade.wallet, key, trade.tokenAmount, trade.tokenDecimals);

    // Track daily realized PNL.
    const day = currentMstDay();
    const dayStats = this.getWalletDayStats(trade.wallet, day);
    dayStats.realizedPnlUsd += pnlUsd;

    log.info('paper sell executed', {
      wallet: trade.wallet,
      token: trade.tokenSymbol,
      sellPct,
      proceedsUsd,
      pnlUsd,
    });

    await this.sendTradeAlert(
      {
        ...trade,
        sellPct,
        entryPriceUsd: pos.avgEntryPriceUsd,
        positionClosed: pos.balance <= 0n,
      },
      ourSellAmount,
      proceedsUsd,
      pnlUsd,
      capitalBefore,
    );

    // Clean up empty positions.
    if (pos.balance <= 0n) {
      this.positions.delete(key);
    }
  }

  private updateWalletPortfolioBuy(
    wallet: string,
    tokenAddress: string,
    tokenAmount: bigint,
    decimals: number,
    tokenPriceUsd: number,
  ): void {
    const walletKey = wallet.toLowerCase();
    const tokenKey = tokenAddress.toLowerCase();
    let portfolio = this.walletPortfolios.get(walletKey);
    if (!portfolio) {
      portfolio = new Map<string, WalletPosition>();
      this.walletPortfolios.set(walletKey, portfolio);
    }

    let pos = portfolio.get(tokenKey);
    if (!pos) {
      pos = { balance: 0n, costBasisUsd: 0, avgEntryPriceUsd: 0, decimals };
      portfolio.set(tokenKey, pos);
    }

    // Normalize the incoming raw amount into the stored decimal scale so
    // repeated buys never mix units within one wallet position.
    let amount = tokenAmount;
    if (pos.decimals !== decimals) {
      amount = BigInt(Math.max(1, Math.floor(Number(tokenAmount) * Math.pow(10, pos.decimals - decimals))));
      log.warn('wallet portfolio decimals mismatch — normalized to stored scale', {
        wallet: walletKey,
        token: tokenKey,
        stored: pos.decimals,
        trade: decimals,
      });
    }

    const buyUsd = (Number(amount) / Math.pow(10, pos.decimals)) * tokenPriceUsd;
    const newCost = pos.costBasisUsd + buyUsd;
    const newBalance = pos.balance + amount;
    pos.avgEntryPriceUsd = newCost / (Number(newBalance) / Math.pow(10, pos.decimals));
    pos.costBasisUsd = newCost;
    pos.balance = newBalance;
  }

  private updateWalletPortfolioSell(
    wallet: string,
    tokenKey: string,
    sellAmount: bigint,
    sellDecimals: number,
  ): void {
    const walletKey = wallet.toLowerCase();
    const portfolio = this.walletPortfolios.get(walletKey);
    if (!portfolio) return;

    const pos = portfolio.get(tokenKey);
    if (!pos) return;

    // Normalize the sell amount into the stored scale before applying it.
    let amount = sellAmount;
    if (pos.decimals !== sellDecimals) {
      amount = BigInt(Math.max(0, Math.floor(Number(sellAmount) * Math.pow(10, pos.decimals - sellDecimals))));
    }

    const costBasisSold = (Number(amount) / Number(pos.balance)) * pos.costBasisUsd;
    pos.balance -= amount;
    pos.costBasisUsd = Math.max(0, pos.costBasisUsd - costBasisSold);

    if (pos.balance <= 0n) {
      portfolio.delete(tokenKey);
    }
  }

  private getWalletDayStats(wallet: string, day: string): WalletDailyStats {
    const walletKey = wallet.toLowerCase();
    let days = this.walletDailyStats.get(walletKey);
    if (!days) {
      days = new Map<string, WalletDailyStats>();
      this.walletDailyStats.set(walletKey, days);
    }

    let stats = days.get(day);
    if (!stats) {
      stats = { realizedPnlUsd: 0, costBasisUsd: 0, trades: 0 };
      days.set(day, stats);
    }
    return stats;
  }

  private async getCurrentTokenPrice(tokenAddress: string): Promise<number> {
    try {
      const pairs = await fetchTokenPairs(tokenAddress);
      const best = pickBestPair(pairs, tokenAddress);
      if (best?.priceUsd) return Number(best.priceUsd);
    } catch (err) {
      log.debug('current price fetch failed', { address: tokenAddress, ...errMeta(err) });
    }
    return 0;
  }

  /**
   * Resolve token decimals and a sane USD price for a detected trade.
   *
   * Some tokens revert on decimals(); the 18-decimal fallback then produces an
   * absurd implied price (e.g. $1e18 per token for a 0-decimal token), which
   * corrupts position sizing. We cross-check the implied price against
   * DexScreener: if it is off by >~30x, we pick the decimals value (0-18)
   * whose implied price best matches the market price. `anchored` is false
   * when no market pair exists yet — callers must NOT size the trade on the
   * blind implied price in that case.
   */
  private async resolveDecimalsAndPrice(
    tokenAddress: string,
    tokenAmountRaw: bigint,
    ethAmount: bigint,
    ethPriceUsd: number,
  ): Promise<{ decimals: number; tokenPriceUsd: number; anchored: boolean }> {
    let decimals = await this.getDecimals(tokenAddress);
    const dexPrice = await this.getCurrentTokenPrice(tokenAddress);

    const impliedPrice = (d: number): number => {
      const qty = Number(tokenAmountRaw) / Math.pow(10, d);
      if (!(qty > 0)) return NaN;
      return (Number(ethAmount) * ethPriceUsd) / qty;
    };

    let price = impliedPrice(decimals);
    if (dexPrice > 0 && Number.isFinite(price) && price > 0) {
      const offBy = Math.abs(Math.log10(price / dexPrice));
      if (offBy > 1.5) {
        let best = decimals;
        let bestOff = offBy;
        for (let d = 0; d <= 18; d++) {
          const p = impliedPrice(d);
          if (!Number.isFinite(p) || p <= 0) continue;
          const off = Math.abs(Math.log10(p / dexPrice));
          if (off < bestOff) {
            bestOff = off;
            best = d;
          }
        }
        log.warn('decimals corrected against market price', {
          token: tokenAddress,
          reported: decimals,
          corrected: best,
          impliedPrice: price,
          dexPrice,
        });
        decimals = best;
        price = impliedPrice(decimals);
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = dexPrice > 0 ? dexPrice : 0;
    }
    return { decimals, tokenPriceUsd: price, anchored: dexPrice > 0 };
  }

  /**
   * Single alert per copied trade, sent AFTER the sell executes.
   * Contains only: token address, copied wallet, PNL $/%, capital
   * before and after the trade. Called AFTER paper state is updated.
   */
  private async sendTradeAlert(
    trade: CopyTrade,
    _ourTokenAmount: bigint,
    _ourUsdAmount: number,
    pnlUsd: number,
    capitalBefore: number,
  ): Promise<void> {
    const endingCapital = this.paperEquity();
    const costBasisSold = Math.max(1e-9, _ourUsdAmount - pnlUsd);
    const pnlPct = (pnlUsd / costBasisSold) * 100;
    const pnlSign = pnlUsd >= 0 ? '+' : '';

    const lines = [
      `<b>SCANETH — Paper copytrade SELL</b>`,
      '',
      `Token: <code>${trade.tokenAddress}</code>`,
      `Copied wallet: <code>${trade.wallet}</code>`,
      '',
      `PNL: <b>${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)</b>`,
      `Capital before trade: $${capitalBefore.toFixed(2)}`,
      `Capital after trade: <b>$${endingCapital.toFixed(2)}</b>`,
    ];

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('copytrade alert failed', { txHash: trade.txHash });
    }
  }

  private getWalletBalanceMap(wallet: string): Map<string, bigint> {
    const key = wallet.toLowerCase();
    let map = this.walletBalances.get(key);
    if (!map) {
      map = new Map<string, bigint>();
      this.walletBalances.set(key, map);
    }
    return map;
  }

  private async getDecimals(address: string): Promise<number> {
    try {
      const contract = new Contract(address, ['function decimals() view returns (uint8)'], this.provider);
      return Number(await contract['decimals']!());
    } catch {
      return 18;
    }
  }

  private async getName(address: string): Promise<string> {
    try {
      const contract = new Contract(address, ['function name() view returns (string)'], this.provider);
      return String(await contract['name']!());
    } catch {
      return 'Unknown';
    }
  }

  private async getSymbol(address: string): Promise<string> {
    try {
      const contract = new Contract(address, ['function symbol() view returns (string)'], this.provider);
      return String(await contract['symbol']!());
    } catch {
      return '???';
    }
  }
}

/** Current MST day string YYYY-MM-DD. MST = UTC-7. */
function currentMstDay(): string {
  return dayStringAtOffset(-7);
}

function previousMstDay(reportHourUtc: number): string {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), reportHourUtc, 0, 0, 0));
  if (prev.getTime() >= now.getTime()) {
    prev.setUTCDate(prev.getUTCDate() - 1);
  }
  const mst = new Date(prev.getTime() - 7 * 3_600_000);
  return `${mst.getUTCFullYear()}-${String(mst.getUTCMonth() + 1).padStart(2, '0')}-${String(mst.getUTCDate()).padStart(2, '0')}`;
}

function dayStringAtOffset(offsetHours: number): string {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetHours * 3_600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function nextUtcOccurrence(hourUtc: number, minuteUtc: number): Date {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
