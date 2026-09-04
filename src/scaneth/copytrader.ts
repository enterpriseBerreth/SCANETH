/**
 * SCANETH paper copytrader.
 *
 * Watches configured wallets and mirrors their DEX trades in paper mode:
 *   - When a watched wallet buys a token, simulate buying $20 USD worth.
 *   - When a watched wallet sells a token, simulate selling the same percentage
 *     of our paper position.
 *
 * No real transactions are sent. This is a simulation layer only.
 */

import { Contract, Interface, type Provider, type TransactionReceipt, type TransactionResponse } from 'ethers';
import { createLogger, errMeta } from '../logger';
import type { ScanethConfig } from '../config';
import type { ScanethNotifier } from './notifier';

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
  private readonly positions = new Map<string, PaperPosition>(); // token -> position
  private ethUsdPrice = 0;
  private priceTimer?: NodeJS.Timeout;
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
  }

  stop(): void {
    this.running = false;
    if (this.priceTimer) clearTimeout(this.priceTimer);
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

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
