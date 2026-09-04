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

import { Contract, Interface, type Provider, type TransactionReceipt, type TransactionResponse } from 'ethers';
import { createLogger, errMeta } from '../logger';
import type { ScanethConfig } from '../config';
import type { ScanethNotifier } from './notifier';
import { fetchTokenPairs, pickBestPair } from './dexscreener';

const log = createLogger('scaneth:copytrader');

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();
const NATIVE_ETH_SENTINEL = '0x0000000000000000000000000000000000000000';

const CHAINLINK_ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const CHAINLINK_FEED_ABI = ['function latestAnswer() view returns (int256)'];

const UNIV2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable',
  'function swapETHForExactTokens(uint amountOut, address[] path, address to, uint deadline) payable',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] path, address to, uint deadline)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
  'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] path, address to, uint deadline)',
];

const UNIV3_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
];

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
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export interface CopyTraderStats {
  watchedWallets: string[];
  positionCount: number;
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
  }

  getStats(): CopyTraderStats {
    let totalCostBasis = 0;
    let totalRealized = 0;
    let totalUnrealized = 0;

    for (const pos of this.positions.values()) {
      totalCostBasis += pos.costBasisUsd;
      totalRealized += pos.realizedPnlUsd;
      const currentValue = Number(pos.balance) * pos.avgEntryPriceUsd / Math.pow(10, pos.decimals);
      totalUnrealized += currentValue - pos.costBasisUsd;
    }

    return {
      watchedWallets: [...this.watchedWallets],
      positionCount: this.positions.size,
      totalCostBasisUsd: totalCostBasis,
      totalRealizedPnlUsd: totalRealized,
      totalUnrealizedPnlUsd: totalUnrealized,
      tradeCount: 0, // could track separately if needed
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

      for (const tx of block.prefetchedTransactions) {
        const from = tx.from?.toLowerCase();
        if (!from || !this.watchedWallets.has(from)) continue;

        try {
          const receipt = await this.provider.getTransactionReceipt(tx.hash);
          if (!receipt || receipt.status !== 1) continue;

          const trade = await this.parseTrade(tx, receipt, from);
          if (trade) {
            await this.executePaperTrade(trade);
          }
        } catch (err) {
          log.debug('copytrade inspection failed', { txHash: tx.hash, ...errMeta(err) });
        }
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

    this.priceTimer = setTimeout(() => void this.refreshEthPrice(), 60_000);
  }

  private async parseTrade(
    tx: TransactionResponse,
    _receipt: TransactionReceipt,
    wallet: string,
  ): Promise<CopyTrade | null> {
    const routerV2 = new Interface(UNIV2_ROUTER_ABI);
    const routerV3 = new Interface(UNIV3_ROUTER_ABI);

    let parsed: { name: string; args: { [key: string]: unknown } } | null = null;
    let protocol: 'v2' | 'v3' | null = null;

    try {
      parsed = routerV2.parseTransaction({ data: tx.data, value: tx.value }) as unknown as {
        name: string;
        args: { [key: string]: unknown };
      };
      protocol = 'v2';
    } catch {
      try {
        parsed = routerV3.parseTransaction({ data: tx.data, value: tx.value }) as unknown as {
          name: string;
          args: { [key: string]: unknown };
        };
        protocol = 'v3';
      } catch {
        return null;
      }
    }

    if (!parsed) return null;

    const method = parsed.name.toLowerCase();

    // V2 path-based swaps.
    if (protocol === 'v2') {
      const path = parsed.args.path as string[] | undefined;
      if (!path || path.length < 2) return null;

      const tokenIn = path[0]?.toLowerCase();
      const tokenOut = path[path.length - 1]?.toLowerCase();
      if (!tokenIn || !tokenOut) return null;

      const isBuy = tokenIn === WETH || tokenIn === NATIVE_ETH_SENTINEL;
      const isSell = tokenOut === WETH || tokenOut === NATIVE_ETH_SENTINEL;

      // Ignore token-to-token swaps for the MVP.
      if (!isBuy && !isSell) return null;

      const tokenAddress = isBuy ? tokenOut : tokenIn;
      const tokenDecimals = await this.getDecimals(tokenAddress);

      let ethAmount: bigint;
      let tokenAmount: bigint;

      if (isBuy) {
        ethAmount = tx.value;
        tokenAmount =
          method === 'swapethforexacttokens'
            ? BigInt(String(parsed.args.amountOut))
            : BigInt(String(parsed.args.amountOutMin));
      } else {
        // Sell
        tokenAmount =
          method === 'swaptokensforexacteth'
            ? BigInt(String(parsed.args.amountInMax))
            : BigInt(String(parsed.args.amountIn));
        ethAmount = BigInt(String(parsed.args.amountOutMin ?? parsed.args.amountOut));
      }

      if (ethAmount === 0n || tokenAmount === 0n) return null;

      const ethPriceUsd = this.ethUsdPrice || 2500;
      const tokenPriceUsd = (Number(ethAmount) * ethPriceUsd) / (Number(tokenAmount) / Math.pow(10, tokenDecimals));

      return this.buildTrade(wallet, isBuy ? 'buy' : 'sell', tokenAddress, tokenDecimals, tokenAmount, ethAmount, ethPriceUsd, tokenPriceUsd, tx);
    }

    // V3 single-hop swaps.
    if (protocol === 'v3') {
      const params = parsed.args.params as {
        tokenIn: string;
        tokenOut: string;
        amountIn: bigint;
        amountOut: bigint;
        amountInMaximum?: bigint;
        amountOutMinimum?: bigint;
      } | undefined;
      if (!params) return null;

      const tokenIn = params.tokenIn.toLowerCase();
      const tokenOut = params.tokenOut.toLowerCase();
      const isBuy = tokenIn === WETH;
      const isSell = tokenOut === WETH;
      if (!isBuy && !isSell) return null;

      const tokenAddress = isBuy ? tokenOut : tokenIn;
      const tokenDecimals = await this.getDecimals(tokenAddress);

      let ethAmount: bigint;
      let tokenAmount: bigint;

      if (method.includes('exactinput')) {
        ethAmount = isBuy ? params.amountIn : params.amountOut;
        tokenAmount = isBuy ? params.amountOut : params.amountIn;
      } else {
        // exactOutput: amountOut is fixed, amountIn is max
        ethAmount = isBuy ? (params.amountInMaximum ?? 0n) : params.amountOut;
        tokenAmount = isBuy ? params.amountOut : (params.amountInMaximum ?? 0n);
      }

      if (ethAmount === 0n || tokenAmount === 0n) return null;

      const ethPriceUsd = this.ethUsdPrice || 2500;
      const tokenPriceUsd = (Number(ethAmount) * ethPriceUsd) / (Number(tokenAmount) / Math.pow(10, tokenDecimals));

      return this.buildTrade(wallet, isBuy ? 'buy' : 'sell', tokenAddress, tokenDecimals, tokenAmount, ethAmount, ethPriceUsd, tokenPriceUsd, tx);
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
    if (trade.type === 'buy') {
      await this.executePaperBuy(trade);
    } else {
      await this.executePaperSell(trade);
    }
  }

  private async executePaperBuy(trade: CopyTrade): Promise<void> {
    const buyAmountUsd = this.config.copytraderBuyAmountUsd;
    const tokenQty = buyAmountUsd / trade.tokenPriceUsd;
    const tokenAmountBigInt = BigInt(Math.floor(tokenQty * Math.pow(10, trade.tokenDecimals)));

    if (tokenAmountBigInt <= 0n) {
      log.debug('paper buy too small', { token: trade.tokenAddress, price: trade.tokenPriceUsd });
      return;
    }

    // Update watched wallet's tracked balance.
    const walletBalances = this.getWalletBalanceMap(trade.wallet);
    const prevBalance = walletBalances.get(trade.tokenAddress) ?? 0n;
    walletBalances.set(trade.tokenAddress, prevBalance + trade.tokenAmount);

    // Update wallet portfolio.
    this.updateWalletPortfolioBuy(trade.wallet, trade.tokenAddress, tokenAmountBigInt, buyAmountUsd, trade.tokenDecimals);

    // Update paper position.
    const key = trade.tokenAddress.toLowerCase();
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
    pos.updatedAt = trade.timestamp;

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

    await this.sendTradeAlert(trade, tokenAmountBigInt, buyAmountUsd);
  }

  private async executePaperSell(trade: CopyTrade): Promise<void> {
    const key = trade.tokenAddress.toLowerCase();
    const pos = this.positions.get(key);
    if (!pos || pos.balance <= 0n) {
      log.debug('paper sell ignored — no position', { token: trade.tokenAddress });
      return;
    }

    const walletBalances = this.getWalletBalanceMap(trade.wallet);
    const walletBalanceBefore = walletBalances.get(key) ?? trade.tokenAmount;
    if (walletBalanceBefore <= 0n) {
      log.debug('paper sell ignored — wallet balance zero', { token: trade.tokenAddress });
      return;
    }

    const sellPct = Math.min(1, Number(trade.tokenAmount) / Number(walletBalanceBefore));
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
    pos.updatedAt = trade.timestamp;

    // Update watched wallet balance.
    walletBalances.set(key, walletBalanceBefore - trade.tokenAmount);

    // Update wallet portfolio.
    this.updateWalletPortfolioSell(trade.wallet, key, ourSellAmount, pnlUsd);

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

    await this.sendTradeAlert({ ...trade, sellPct }, ourSellAmount, proceedsUsd, pnlUsd);

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

  private getDecimalsFromPositions(tokenAddress: string): number | undefined {
    return this.positions.get(tokenAddress)?.decimals;
  }

  private async sendTradeAlert(
    trade: CopyTrade,
    ourTokenAmount: bigint,
    ourUsdAmount: number,
    pnlUsd?: number,
  ): Promise<void> {
    const tokenQty = Number(ourTokenAmount) / Math.pow(10, trade.tokenDecimals);
    const isBuy = trade.type === 'buy';

    const lines = [
      `<b>SCANETH — Paper copytrade ${isBuy ? 'BUY' : 'SELL'}</b>`,
      '',
      `Copied wallet: <code>${trade.wallet}</code>`,
      `Token: <b>${escapeHtml(trade.tokenName)} (${escapeHtml(trade.tokenSymbol)})</b>`,
      `Address: <code>${trade.tokenAddress}</code>`,
      '',
      `<b>Our paper trade</b>`,
      `${isBuy ? 'Bought' : 'Sold'}: ${tokenQty.toFixed(4)} ${escapeHtml(trade.tokenSymbol)}`,
      `Amount: $${ourUsdAmount.toFixed(2)}`,
      `Price: $${trade.tokenPriceUsd.toExponential(4)}`,
    ];

    if (!isBuy && trade.sellPct !== undefined) {
      lines.push(`Mirrored sell: ${(trade.sellPct * 100).toFixed(2)}% of copied position`);
    }

    if (pnlUsd !== undefined) {
      const sign = pnlUsd >= 0 ? '+' : '';
      lines.push(`Trade PNL: <b>${sign}$${pnlUsd.toFixed(2)}</b>`);
    }

    lines.push('');
    lines.push(
      `<a href="https://etherscan.io/tx/${trade.txHash}">Tx</a> · ` +
        `<a href="https://etherscan.io/token/${trade.tokenAddress}">Token</a>`,
    );

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
