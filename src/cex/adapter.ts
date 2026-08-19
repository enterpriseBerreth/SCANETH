/**
 * ccxt-based CEX adapter for CEX-DEX inventory arbitrage.
 *
 * Responsibilities:
 * - Create ccxt exchange instances from config credentials.
 * - Fetch balances for the tokens we trade.
 * - Fetch best bid/ask for a symbol.
 * - Place market orders (paper mode can stub this).
 * - Withdraw to an on-chain address.
 *
 * Error handling is defensive: exchange downtime, rate limits, or API errors
 * are caught and reported, never thrown into the main loop.
 */
import ccxt, { type Exchange } from 'ccxt';
import type { ArboConfig } from '../config.js';

export type OrderSide = 'buy' | 'sell';

export interface MarketQuote {
  bid: number;
  ask: number;
  bidVolume: number;
  askVolume: number;
  timestamp: number;
}

export interface OrderResult {
  orderId: string;
  averagePrice: number;
  filledAmount: number;
  cost: number;
  fee?: { cost: number; currency: string };
}

export interface BalanceSnapshot {
  [asset: string]: number;
}

export class CexAdapter {
  private exchanges: Map<string, Exchange> = new Map();

  constructor(private readonly config: ArboConfig) {}

  async init(): Promise<void> {
    for (const exchangeId of this.config.cexExchanges) {
      if (!this.config.cexDexEnabled) continue;
      const creds = this.config.cexCredentials[exchangeId];
      const ExchangeClass = (ccxt as Record<string, unknown>)[exchangeId] as
        | typeof ccxt.Exchange
        | undefined;
      if (!ExchangeClass) {
        console.warn(`[cex] unknown exchange "${exchangeId}"`);
        continue;
      }

      const instance = new ExchangeClass({
        apiKey: creds?.apiKey,
        secret: creds?.secret,
        password: creds?.password,
        enableRateLimit: true,
        sandbox: creds?.sandbox ?? false,
      });

      try {
        await instance.loadMarkets();
        this.exchanges.set(exchangeId, instance);
      } catch (err) {
        console.warn(`[cex] failed to load markets for ${exchangeId}:`, err);
      }
    }
  }

  hasExchange(id: string): boolean {
    return this.exchanges.has(id);
  }

  async quote(exchangeId: string, symbol: string): Promise<MarketQuote | undefined> {
    const ex = this.exchanges.get(exchangeId);
    if (!ex) return undefined;
    try {
      const ticker = await ex.fetchTicker(symbol);
      return {
        bid: ticker.bid ?? 0,
        ask: ticker.ask ?? 0,
        bidVolume: ticker.bidVolume ?? 0,
        askVolume: ticker.askVolume ?? 0,
        timestamp: ticker.timestamp ?? Date.now(),
      };
    } catch (err) {
      console.warn(`[cex] quote failed ${exchangeId}:${symbol}`, err);
      return undefined;
    }
  }

  async balances(exchangeId: string): Promise<BalanceSnapshot | undefined> {
    const ex = this.exchanges.get(exchangeId);
    if (!ex) return undefined;
    try {
      const bal = await ex.fetchBalance();
      const snapshot: BalanceSnapshot = {};
      for (const [asset, info] of Object.entries(bal.total as unknown as Record<string, number>)) {
        if (info && info > 0) snapshot[asset] = info;
      }
      return snapshot;
    } catch (err) {
      console.warn(`[cex] balance fetch failed ${exchangeId}`, err);
      return undefined;
    }
  }

  /**
   * Place a market order. In paper mode the caller should not invoke this -
   * it is live only.
   */
  async marketOrder(
    exchangeId: string,
    symbol: string,
    side: OrderSide,
    amount: number,
  ): Promise<OrderResult | undefined> {
    const ex = this.exchanges.get(exchangeId);
    if (!ex) return undefined;
    try {
      const order = await ex.createMarketOrder(symbol, side, amount);
      return {
        orderId: String(order.id ?? 'unknown'),
        averagePrice: order.average ?? order.price ?? 0,
        filledAmount: order.filled ?? amount,
        cost: order.cost ?? 0,
        fee: order.fee
          ? { cost: order.fee.cost ?? 0, currency: order.fee.currency ?? '' }
          : undefined,
      };
    } catch (err) {
      console.warn(`[cex] market order failed ${exchangeId}:${symbol}`, err);
      return undefined;
    }
  }

  async withdraw(
    exchangeId: string,
    asset: string,
    amount: number,
    address: string,
    network?: string,
  ): Promise<{ id: string } | undefined> {
    const ex = this.exchanges.get(exchangeId);
    if (!ex) return undefined;
    try {
      const params = network ? { network } : undefined;
      const result = await ex.withdraw(asset, amount, address, undefined, params);
      return { id: String(result.id ?? 'unknown') };
    } catch (err) {
      console.warn(`[cex] withdraw failed ${exchangeId}:${asset}`, err);
      return undefined;
    }
  }

  /** taker fee for a symbol, in bps. */
  async feeBps(exchangeId: string, symbol: string): Promise<number> {
    const ex = this.exchanges.get(exchangeId);
    if (!ex) return 10;
    try {
      const market = ex.market(symbol);
      const taker = market.taker ?? 0;
      return taker * 10_000;
    } catch {
      return 10;
    }
  }
}
