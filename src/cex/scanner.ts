/**
 * Cross-venue CEX spread scanner.
 *
 * IMPORTANT — this engine cannot use flash loans. A flash loan must be repaid
 * inside a single blockchain transaction, whereas moving value between exchanges
 * takes minutes and involves off-chain settlement. Capturing these spreads
 * therefore requires pre-funded inventory on both venues simultaneously: you
 * sell the asset you already hold on the expensive venue and buy it back on the
 * cheap one, keeping both balances roughly flat. Nothing here is executable
 * without API keys and pre-positioned capital, so this engine reports only.
 *
 * Spreads are computed by walking both order books, not from top-of-book. A
 * headline "0.5% spread" that only exists for $80 of depth is not an
 * opportunity, and reporting it as one would be misleading.
 */

import { createLogger, errMeta } from '../logger';
import type { ArboConfig } from '../config';
import type { CexSpread } from '../types';
import type { BookLevel, CexFeeds, VenueBook } from './feeds';

const log = createLogger('cex:scanner');

interface WalkResult {
  baseSize: number;
  buyCost: number;
  sellRevenue: number;
  avgAsk: number;
  avgBid: number;
}

/**
 * Consume both books level by level for as long as the trade stays profitable
 * after costs, giving the size actually executable rather than a headline number.
 */
function walkBooks(bids: BookLevel[], asks: BookLevel[], costFraction: number): WalkResult {
  let i = 0;
  let j = 0;
  let bidLeft = bids[0]?.amount ?? 0;
  let askLeft = asks[0]?.amount ?? 0;

  let baseSize = 0;
  let buyCost = 0;
  let sellRevenue = 0;

  while (i < bids.length && j < asks.length) {
    const bid = bids[i];
    const ask = asks[j];
    if (!bid || !ask) break;

    // Stop as soon as this level pairing stops covering fees and transfer costs.
    if (bid.price * (1 - costFraction) <= ask.price) break;

    const take = Math.min(bidLeft, askLeft);
    if (!(take > 0)) break;

    baseSize += take;
    sellRevenue += take * bid.price;
    buyCost += take * ask.price;
    bidLeft -= take;
    askLeft -= take;

    if (bidLeft <= 0) {
      i += 1;
      bidLeft = bids[i]?.amount ?? 0;
    }
    if (askLeft <= 0) {
      j += 1;
      askLeft = asks[j]?.amount ?? 0;
    }
  }

  return {
    baseSize,
    buyCost,
    sellRevenue,
    avgAsk: baseSize > 0 ? buyCost / baseSize : 0,
    avgBid: baseSize > 0 ? sellRevenue / baseSize : 0,
  };
}

/** Evaluate one directed pair of venues: buy on `buy`, sell on `sell`. */
function evaluate(
  symbol: string,
  buy: VenueBook,
  sell: VenueBook,
  transferCostBps: number,
): CexSpread | undefined {
  const bestAsk = buy.asks[0]?.price;
  const bestBid = sell.bids[0]?.price;
  if (!bestAsk || !bestBid || bestAsk <= 0) return undefined;

  // Quick reject before the more expensive walk.
  const costFraction = buy.takerFee + sell.takerFee + transferCostBps / 10_000;
  if (bestBid * (1 - costFraction) <= bestAsk) return undefined;

  const walk = walkBooks(sell.bids, buy.asks, costFraction);
  if (walk.baseSize <= 0 || walk.avgAsk <= 0) return undefined;

  const grossBps = ((walk.avgBid - walk.avgAsk) / walk.avgAsk) * 10_000;
  const netBps = grossBps - (buy.takerFee + sell.takerFee) * 10_000 - transferCostBps;
  if (netBps <= 0) return undefined;

  return {
    symbol,
    buyVenue: buy.venue,
    sellVenue: sell.venue,
    buyPrice: Number(walk.avgAsk.toPrecision(10)),
    sellPrice: Number(walk.avgBid.toPrecision(10)),
    grossBps,
    netBps,
    // Quote currency is USD-pegged for the configured symbols, so buyCost is a
    // fair USD notional.
    availableUsd: walk.buyCost,
    discoveredAt: Date.now(),
  };
}

/** Scan every configured symbol across every venue pairing, both directions. */
export async function scanCexSpreads(
  feeds: CexFeeds,
  config: ArboConfig,
): Promise<CexSpread[]> {
  const found: CexSpread[] = [];

  for (const symbol of config.cexSymbols) {
    let books: VenueBook[];
    try {
      books = await feeds.fetchBooks(symbol);
    } catch (err) {
      log.warn('book fetch failed for symbol', { symbol, ...errMeta(err) });
      continue;
    }

    if (books.length < 2) continue;

    for (const buy of books) {
      for (const sell of books) {
        if (buy.venue === sell.venue) continue;
        const spread = evaluate(symbol, buy, sell, config.cexTransferCostBps);
        if (spread && spread.netBps >= config.cexMinSpreadBps) {
          found.push(spread);
        }
      }
    }
  }

  return found.sort((a, b) => b.netBps - a.netBps);
}
