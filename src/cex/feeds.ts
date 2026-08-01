/**
 * CEX public market data via ccxt.
 *
 * No API keys are used or required here — everything is public endpoint data.
 * Exchanges that geo-block, rate-limit or simply do not list a symbol are
 * skipped rather than allowed to fail the scan.
 */

import * as ccxt from 'ccxt';
import { createLogger, errMeta } from '../logger';

const log = createLogger('cex:feeds');

export interface BookLevel {
  price: number;
  amount: number;
}

export interface VenueBook {
  venue: string;
  symbol: string;
  bids: BookLevel[];
  asks: BookLevel[];
  /** Taker fee as a fraction, e.g. 0.001 for 10 bps. */
  takerFee: number;
  fetchedAt: number;
}

/** The slice of the ccxt surface ARBO actually touches. */
interface MinimalExchange {
  id: string;
  loadMarkets(reload?: boolean): Promise<Record<string, unknown>>;
  fetchOrderBook(
    symbol: string,
    limit?: number,
  ): Promise<{ bids: Array<[number, number]>; asks: Array<[number, number]> }>;
  markets?: Record<string, { taker?: number; active?: boolean } | undefined>;
  close?(): Promise<void>;
}

type ExchangeConstructor = new (config: Record<string, unknown>) => MinimalExchange;

/** Assumed taker fee when an exchange does not advertise one. */
const DEFAULT_TAKER_FEE = 0.001;

const ORDER_BOOK_DEPTH = 20;

export class CexFeeds {
  private exchanges = new Map<string, MinimalExchange>();
  private marketsLoaded = new Set<string>();
  private unavailable = new Set<string>();

  constructor(private readonly venueIds: string[]) {}

  /** Instantiate configured exchanges and load their market metadata once. */
  async init(): Promise<string[]> {
    const registry = ccxt as unknown as Record<string, ExchangeConstructor | undefined>;

    for (const id of this.venueIds) {
      const Ctor = registry[id];
      if (typeof Ctor !== 'function') {
        log.warn('unknown exchange id, skipping', { venue: id });
        this.unavailable.add(id);
        continue;
      }

      try {
        const exchange = new Ctor({ enableRateLimit: true, timeout: 15_000 });
        this.exchanges.set(id, exchange);
      } catch (err) {
        log.warn('could not construct exchange', { venue: id, ...errMeta(err) });
        this.unavailable.add(id);
      }
    }

    // Load markets in parallel; a slow venue should not block the others.
    await Promise.all(
      [...this.exchanges.entries()].map(async ([id, exchange]) => {
        try {
          await exchange.loadMarkets();
          this.marketsLoaded.add(id);
        } catch (err) {
          log.warn('loadMarkets failed — venue disabled', { venue: id, ...errMeta(err) });
          this.unavailable.add(id);
          this.exchanges.delete(id);
        }
      }),
    );

    const ready = [...this.marketsLoaded];
    log.info('cex feeds ready', { ready, unavailable: [...this.unavailable] });
    return ready;
  }

  private takerFee(exchange: MinimalExchange, symbol: string): number {
    const market = exchange.markets?.[symbol];
    const fee = market?.taker;
    return typeof fee === 'number' && fee >= 0 ? fee : DEFAULT_TAKER_FEE;
  }

  private supports(exchange: MinimalExchange, symbol: string): boolean {
    const market = exchange.markets?.[symbol];
    return !!market && market.active !== false;
  }

  /** Fetch order books for one symbol across every ready venue. */
  async fetchBooks(symbol: string): Promise<VenueBook[]> {
    const tasks = [...this.exchanges.entries()].map(async ([id, exchange]) => {
      if (!this.supports(exchange, symbol)) return undefined;

      try {
        const book = await exchange.fetchOrderBook(symbol, ORDER_BOOK_DEPTH);
        const bids = (book.bids ?? [])
          .filter((l) => Array.isArray(l) && l.length >= 2 && l[0] > 0 && l[1] > 0)
          .map(([price, amount]) => ({ price, amount }));
        const asks = (book.asks ?? [])
          .filter((l) => Array.isArray(l) && l.length >= 2 && l[0] > 0 && l[1] > 0)
          .map(([price, amount]) => ({ price, amount }));

        if (bids.length === 0 || asks.length === 0) return undefined;

        return {
          venue: id,
          symbol,
          bids,
          asks,
          takerFee: this.takerFee(exchange, symbol),
          fetchedAt: Date.now(),
        } satisfies VenueBook;
      } catch (err) {
        log.debug('order book fetch failed', { venue: id, symbol, ...errMeta(err) });
        return undefined;
      }
    });

    const settled = await Promise.all(tasks);
    return settled.filter((b): b is VenueBook => b !== undefined);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.exchanges.values()].map(async (exchange) => {
        try {
          await exchange.close?.();
        } catch {
          // Nothing useful to do on shutdown.
        }
      }),
    );
  }
}
