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
}

interface WalletPosition {
  balance: bigint;
  costBasisUsd: number;
  avgEntryPriceUsd: number;
}

interface WalletDailyStats {
  realizedPnlUsd: number;
  costBasisUsd: number;
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
  /** Trades observed per watched wallet (for scout ranking). */
  private readonly walletTradeCounts = new Map<string, number>();
  /** Remaining paper cash. Starts at the configured budget, decreases on buys, grows on sells. */
  private cashUsd: number;
  private ethUsdPrice = 0;
  private priceTimer?: NodeJS.Timeout;
  private reportTimer?: NodeJS.Timeout;
  private running = false;

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

  getStats(): CopyTraderStats {
    let totalCostBasis = 0;
    let totalRealized = 0;
    let totalUnrealized = 0;
    let openValue = 0;

    for (const pos of this.positions.values()) {
      totalCostBasis += pos.costBasisUsd;
      totalRealized += pos.realizedPnlUsd;
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
      totalRealizedPnlUsd: totalRealized,
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
    void this.refreshEthPrice();
    this.scheduleDailyWalletReport();
  }

  stop(): void {
    this.running = false;
    if (this.priceTimer) clearTimeout(this.priceTimer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
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
    const walletPnls: Array<{ wallet: string; realizedUsd: number; unrealizedUsd: number; totalPnlUsd: number; pnlPct: number }> = [];

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
          const tokenQty = Number(pos.balance) / Math.pow(10, this.getDecimalsFromPositions(tokenLower) ?? 18);
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
      });
    }

    walletPnls.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);

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
        `   PNL: <b>${sign}$${w.totalPnlUsd.toFixed(2)} (${pctSign}${w.pnlPct.toFixed(2)}%)</b>\n` +
        `   Realized: $${w.realizedUsd.toFixed(2)} · Unrealized: $${w.unrealizedUsd.toFixed(2)}`
      );
    });

    const message =
      `<b>SCANETH — Copied wallet rankings (${previousDay})</b>\n\n` +
      lines.join('\n\n');

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

    // Auto-sell positions that have dropped past the stop-loss threshold.
    await this.enforceStopLoss();

    this.priceTimer = setTimeout(() => void this.refreshEthPrice(), 60_000);
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

  /**
   * Auto-sell any open position trading below entry by the stop-loss percent.
   * Runs after every mark-to-market cycle (every 60s). Disabled at 0.
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

      // Exit the entire position at the current market price.
      const qty = Number(pos.balance) / Math.pow(10, pos.decimals);
      const proceedsUsd = qty * price;
      const pnlUsd = proceedsUsd - pos.costBasisUsd;

      pos.balance = 0n;
      pos.realizedPnlUsd += pnlUsd;
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

      await this.sendStopLossAlert(pos, price, proceedsUsd, pnlUsd);
    }
  }

  /** Alert for a stop-loss exit of a paper position. */
  private async sendStopLossAlert(
    pos: PaperPosition,
    exitPrice: number,
    proceedsUsd: number,
    pnlUsd: number,
  ): Promise<void> {
    const costBasisSold = Math.max(1e-9, proceedsUsd - pnlUsd);
    const pnlPct = (pnlUsd / costBasisSold) * 100;
    const pnlSign = pnlUsd >= 0 ? '+' : '';
    const endingCapital = this.paperEquity();

    const lines = [
      `<b>SCANETH — Paper copytrade SELL (stop-loss)</b>`,
      '',
      `Token: <b>${escapeHtml(pos.name)} (${escapeHtml(pos.symbol)})</b>`,
      `Address: <code>${pos.tokenAddress}</code>`,
      '',
      `Entry: $${pos.avgEntryPriceUsd.toExponential(4)} → Exit: $${exitPrice.toExponential(4)}`,
      `Mirrored sell: 100.00% of position`,
      `Amount paper traded: <b>$${proceedsUsd.toFixed(2)}</b>`,
      `PNL: <b>${pnlSign}$${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)</b>`,
      `Starting capital: $${this.config.copytraderStartingBudgetUsd.toFixed(2)}`,
      `Ending capital: <b>$${endingCapital.toFixed(2)}</b>`,
      '',
      `⛔ Auto-exited at −${this.config.copytraderStopLossPct}% stop-loss — no wallet exit was detected`,
      '',
      `<a href="https://etherscan.io/token/${pos.tokenAddress}">Token</a>`,
    ];

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('stop-loss alert failed', { token: pos.tokenAddress });
    }
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
      const { decimals, tokenPriceUsd } = await this.resolveDecimalsAndPrice(tokenAddress, tokenAmount, ethAmount, ethPriceUsd);
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
    log.info('scout removed wallet', { wallet: key });
    return true;
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
          unrealized += (Number(pos.balance) / Math.pow(10, live?.decimals ?? 18)) * (price - pos.avgEntryPriceUsd);
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
    const theirQty = Number(trade.tokenAmount) / Math.pow(10, trade.tokenDecimals);
    this.updateWalletPortfolioBuy(trade.wallet, trade.tokenAddress, trade.tokenAmount, theirQty * trade.tokenPriceUsd, trade.tokenDecimals);

    const buyAmountUsd = this.config.copytraderBuyAmountUsd;

    // Respect the paper cash budget.
    if (this.cashUsd < buyAmountUsd) {
      log.debug('paper buy skipped — out of cash', { token: trade.tokenAddress, cashUsd: this.cashUsd });
      await this.sendObservedAlert(
        trade,
        `Out of paper cash ($${this.cashUsd.toFixed(2)} left of $${this.config.copytraderStartingBudgetUsd} budget) — not copying`,
      );
      return;
    }

    const tokenQty = buyAmountUsd / trade.tokenPriceUsd;
    const tokenAmountBigInt = BigInt(Math.floor(tokenQty * Math.pow(10, trade.tokenDecimals)));

    if (tokenAmountBigInt <= 0n) {
      log.debug('paper buy too small', { token: trade.tokenAddress, price: trade.tokenPriceUsd });
      return;
    }

    // Update paper position.
    let pos = this.positions.get(key);
    if (!pos) {
      pos = {
        tokenAddress: trade.tokenAddress,
        name: trade.tokenName,
        symbol: trade.tokenSymbol,
        decimals: trade.tokenDecimals,
        balance: 0n,
        costBasisUsd: 0,
        avgEntryPriceUsd: 0,
        realizedPnlUsd: 0,
        currentPriceUsd: trade.tokenPriceUsd,
        openedAt: trade.timestamp,
        updatedAt: trade.timestamp,
      };
      this.positions.set(key, pos);
    }

    const newCost = pos.costBasisUsd + buyAmountUsd;
    const newBalance = pos.balance + tokenAmountBigInt;
    pos.avgEntryPriceUsd = newCost / (Number(newBalance) / Math.pow(10, trade.tokenDecimals));
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
      await this.sendObservedAlert(trade, 'No paper position in this token');
      return;
    }

    // Any watched wallet's exit counts: mirror the fraction of THEIR
    // position that they sold, applied to our aggregated position.
    const sellPct = walletBalanceBefore > 0n ? Math.min(1, Number(trade.tokenAmount) / Number(walletBalanceBefore)) : 1;
    const ourSellAmount = BigInt(Math.floor(Number(pos.balance) * sellPct));

    if (ourSellAmount <= 0n) {
      log.debug('paper sell too small', { token: trade.tokenAddress });
      return;
    }

    const proceedsUsd = (Number(ourSellAmount) / Math.pow(10, trade.tokenDecimals)) * trade.tokenPriceUsd;
    const costBasisSold = (Number(ourSellAmount) / Math.pow(10, trade.tokenDecimals)) * pos.avgEntryPriceUsd;
    const pnlUsd = proceedsUsd - costBasisSold;

    pos.balance -= ourSellAmount;
    pos.realizedPnlUsd += pnlUsd;
    pos.costBasisUsd = Math.max(0, pos.costBasisUsd - costBasisSold);
    pos.currentPriceUsd = trade.tokenPriceUsd;
    pos.updatedAt = trade.timestamp;

    // Credit sale proceeds back to the paper cash budget.
    this.cashUsd += proceedsUsd;

    // Update wallet portfolio.
    this.updateWalletPortfolioSell(trade.wallet, key, trade.tokenAmount, pnlUsd);

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
    buyAmountUsd: number,
    decimals: number,
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
      pos = { balance: 0n, costBasisUsd: 0, avgEntryPriceUsd: 0 };
      portfolio.set(tokenKey, pos);
    }

    const newCost = pos.costBasisUsd + buyAmountUsd;
    const newBalance = pos.balance + tokenAmount;
    pos.avgEntryPriceUsd = newCost / (Number(newBalance) / Math.pow(10, decimals));
    pos.costBasisUsd = newCost;
    pos.balance = newBalance;
  }

  private updateWalletPortfolioSell(wallet: string, tokenKey: string, sellAmount: bigint, pnlUsd: number): void {
    const walletKey = wallet.toLowerCase();
    const portfolio = this.walletPortfolios.get(walletKey);
    if (!portfolio) return;

    const pos = portfolio.get(tokenKey);
    if (!pos) return;

    const costBasisSold = (Number(sellAmount) / Number(pos.balance)) * pos.costBasisUsd;
    pos.balance -= sellAmount;
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
      stats = { realizedPnlUsd: 0, costBasisUsd: 0 };
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
   * corrupts position sizing and trips the stop-loss instantly. We cross-check
   * the implied price against DexScreener: if it is off by >~30x, we pick the
   * decimals value (0-18) whose implied price best matches the market price.
   */
  private async resolveDecimalsAndPrice(
    tokenAddress: string,
    tokenAmountRaw: bigint,
    ethAmount: bigint,
    ethPriceUsd: number,
  ): Promise<{ decimals: number; tokenPriceUsd: number }> {
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
    return { decimals, tokenPriceUsd: price };
  }

  private getDecimalsFromPositions(tokenAddress: string): number | undefined {
    return this.positions.get(tokenAddress)?.decimals;
  }

  /**
   * Single alert per copied trade, sent AFTER the sell executes.
   * Includes the paper account snapshot: wallet, token, entry/exit,
   * amount paper traded, PNL $/%, starting and ending capital.
   * Called AFTER paper state (cash/positions) has been updated.
   */
  private async sendTradeAlert(
    trade: CopyTrade,
    ourTokenAmount: bigint,
    ourUsdAmount: number,
    pnlUsd?: number,
  ): Promise<void> {
    const isBuy = trade.type === 'buy';
    const startingCapital = this.config.copytraderStartingBudgetUsd;

    // Ending capital: cash + market value of open positions, after this trade.
    let openValue = 0;
    for (const pos of this.positions.values()) {
      const price = pos.currentPriceUsd > 0 ? pos.currentPriceUsd : pos.avgEntryPriceUsd;
      openValue += (Number(pos.balance) / Math.pow(10, pos.decimals)) * price;
    }
    const endingCapital = this.cashUsd + openValue;

    // PNL: 0 for a fresh buy (realized on sell); % relative to the cost basis sold.
    const tradePnl = pnlUsd ?? 0;
    const costBasisSold = isBuy ? 0 : Math.max(1e-9, ourUsdAmount - tradePnl);
    const pnlPct = isBuy ? 0 : (tradePnl / costBasisSold) * 100;
    const pnlSign = tradePnl >= 0 ? '+' : '';

    const lines = [
      `<b>SCANETH — Paper copytrade SELL</b>`,
      '',
      `Copied wallet: <code>${trade.wallet}</code>`,
      `Token: <b>${escapeHtml(trade.tokenName)} (${escapeHtml(trade.tokenSymbol)})</b>`,
      `Address: <code>${trade.tokenAddress}</code>`,
      '',
    ];

    if (trade.entryPriceUsd !== undefined) {
      lines.push(`Entry: $${trade.entryPriceUsd.toExponential(4)} → Exit: $${trade.tokenPriceUsd.toExponential(4)}`);
    }
    if (trade.sellPct !== undefined) {
      lines.push(`Mirrored sell: ${(trade.sellPct * 100).toFixed(2)}% of position`);
    }

    lines.push(
      `Amount paper traded: <b>$${ourUsdAmount.toFixed(2)}</b>`,
      `PNL: <b>${pnlSign}$${tradePnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)</b>`,
      `Starting capital: $${startingCapital.toFixed(2)}`,
      `Ending capital: <b>$${endingCapital.toFixed(2)}</b>`,
    );

    if (trade.positionClosed) {
      lines.push('', `✅ Position fully closed`);
    }

    lines.push(
      '',
      `<a href="https://etherscan.io/tx/${trade.txHash}">Tx</a> · ` +
        `<a href="https://etherscan.io/token/${trade.tokenAddress}">Token</a>`,
    );

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('copytrade alert failed', { txHash: trade.txHash });
    }
  }

  /** Alert on a watched-wallet trade we detected but did not mirror. */
  private async sendObservedAlert(trade: CopyTrade, reason: string): Promise<void> {
    const isBuy = trade.type === 'buy';
    const tokenQty = Number(trade.tokenAmount) / Math.pow(10, trade.tokenDecimals);
    const ethQty = Number(trade.ethAmount) / 1e18;

    const lines = [
      `<b>SCANETH — Watched wallet ${isBuy ? 'BUY' : 'SELL'} (not copied)</b>`,
      '',
      `Wallet: <code>${trade.wallet}</code>`,
      `Token: <b>${escapeHtml(trade.tokenName)} (${escapeHtml(trade.tokenSymbol)})</b>`,
      `Address: <code>${trade.tokenAddress}</code>`,
      '',
      `Their trade: ${tokenQty.toPrecision(4)} ${escapeHtml(trade.tokenSymbol)} for ~${ethQty.toFixed(4)} ETH`,
      `Reason: ${escapeHtml(reason)}`,
      '',
      `<a href="https://etherscan.io/tx/${trade.txHash}">Tx</a> · ` +
        `<a href="https://etherscan.io/token/${trade.tokenAddress}">Token</a>`,
    ];

    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) {
      log.warn('observed trade alert failed', { txHash: trade.txHash });
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
