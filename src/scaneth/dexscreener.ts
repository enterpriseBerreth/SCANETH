/**
 * DEXScreener API client.
 *
 * Used to enrich newly launched tokens with live pair data: age, transaction
 * counts, buys/sells, liquidity, market cap, and holder concentration.
 */

import { createLogger, errMeta } from '../logger';

const log = createLogger('scaneth:dexscreener');

export interface DexScreenerTokenInfo {
  url: string;
  address: string;
  name: string;
  symbol: string;
}

export interface DexScreenerTxnBucket {
  /** Number of buys in this bucket. */
  buys: number;
  /** Number of sells in this bucket. */
  sells: number;
  /** Number of buyers (unique wallets). */
  buyers: number;
  /** Number of sellers (unique wallets). */
  sellers: number;
  /** Total volume in USD. */
  volume: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexScreenerTokenInfo;
  quoteToken: DexScreenerTokenInfo;
  /** Unix milliseconds when the pair was created on DEXScreener. */
  pairCreatedAt?: number;
  /** Price in USD of the base token. */
  priceUsd?: string;
  /** Market cap in USD. */
  marketCap?: number;
  /** Liquidity in USD. */
  liquidity?: { usd?: number };
  /** Transaction buckets. */
  txns?: {
    m5?: DexScreenerTxnBucket;
    h1?: DexScreenerTxnBucket;
    h6?: DexScreenerTxnBucket;
    h24?: DexScreenerTxnBucket;
  };
  /**
   * DEXScreener sometimes returns this for newly-created pairs instead of
   * txns; we treat it the same way when present.
   */
  volume?: {
    h24?: number;
    h6?: number;
    h1?: number;
    m5?: number;
  };
}

export interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

/** Fetch DEXScreener pair data for a token address. */
export async function fetchTokenPairs(
  tokenAddress: string,
  signal?: AbortSignal,
): Promise<DexScreenerPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

  try {
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.debug('dexscreener request failed', {
        address: tokenAddress,
        status: response.status,
      });
      return [];
    }

    const data = (await response.json()) as DexScreenerResponse;
    return data.pairs ?? [];
  } catch (err) {
    log.debug('dexscreener fetch failed', { address: tokenAddress, ...errMeta(err) });
    return [];
  }
}

/**
 * Pick the best pair for a token. Prefer Ethereum mainnet pairs with the
 * deepest liquidity; fall back to any pair if no mainnet pair exists.
 */
export function pickBestPair(pairs: DexScreenerPair[], tokenAddress: string): DexScreenerPair | null {
  if (pairs.length === 0) return null;

  const tokenLower = tokenAddress.toLowerCase();
  const ethPairs = pairs.filter(
    (p) =>
      p.chainId === 'ethereum' ||
      p.baseToken.address.toLowerCase() === tokenLower ||
      p.quoteToken.address.toLowerCase() === tokenLower,
  );

  const candidates = ethPairs.length > 0 ? ethPairs : pairs;

  // Prefer the pair with the highest 1-hour transaction count, then liquidity.
  return candidates.sort((a, b) => {
    const aTxns = a.txns?.h1 ? a.txns.h1.buys + a.txns.h1.sells : 0;
    const bTxns = b.txns?.h1 ? b.txns.h1.buys + b.txns.h1.sells : 0;
    if (bTxns !== aTxns) return bTxns - aTxns;
    return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
  })[0] ?? null;
}

/** Compute token age in milliseconds from the pair creation timestamp. */
export function pairAgeMs(pair: DexScreenerPair): number | null {
  if (!pair.pairCreatedAt) return null;
  return Date.now() - pair.pairCreatedAt;
}

export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
