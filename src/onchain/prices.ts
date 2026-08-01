/**
 * On-chain price oracle.
 *
 * Gas is paid in the native token, so costing an opportunity in USD needs a
 * native/USD price. Hardcoding it is a real hazard: if the constant says $3000
 * while ETH trades at $1865, every gas estimate is 60% too high and the bot
 * silently rejects profitable trades (or worse, in the other direction,
 * accepts unprofitable ones).
 *
 * So prices are derived from the pools we already read. Stablecoins anchor at
 * $1, tokens paired with a stablecoin are priced directly from reserves, and
 * everything else is priced transitively through an already-priced token. This
 * costs zero extra RPC calls because it reuses the reserve snapshot taken for
 * scanning.
 */

import type { PoolSet } from './dex';
import { v2LiquidityUsd, v2SpotPrice } from './dex/univ2';
import type { ChainConfig, TokenInfo } from '../types';
import { createLogger } from '../logger';

const log = createLogger('prices');

export class PriceOracle {
  private prices = new Map<string, number>();
  private lastUpdated = 0;

  constructor(private readonly chain: ChainConfig) {
    // Seed with coarse hints so the very first scan is never priceless.
    for (const token of chain.tokens) {
      if (token.stable) this.prices.set(this.key(token.address), 1);
      else if (token.usdHint) this.prices.set(this.key(token.address), token.usdHint);
    }
  }

  private key(address: string): string {
    return address.toLowerCase();
  }

  /**
   * Recompute prices from a fresh reserve snapshot.
   * Two propagation passes: stable-paired tokens first, then tokens that only
   * pair against those.
   */
  refresh(pools: PoolSet): void {
    const derived = new Map<string, number>();
    for (const token of this.chain.tokens) {
      if (token.stable) derived.set(this.key(token.address), 1);
    }

    // Prefer the deepest pool for each token, so a dust pool cannot set the price.
    for (let pass = 0; pass < 2; pass += 1) {
      const best = new Map<string, { price: number; liquidity: number }>();

      for (const pool of pools.v2) {
        if (pool.reserveA <= 0n || pool.reserveB <= 0n) continue;

        const keyA = this.key(pool.tokenA.address);
        const keyB = this.key(pool.tokenB.address);
        const knownA = derived.get(keyA);
        const knownB = derived.get(keyB);
        const liquidity = v2LiquidityUsd(pool);

        // Price B from A.
        if (knownA !== undefined && knownB === undefined) {
          const bPerA = v2SpotPrice(pool, true);
          if (bPerA > 0) {
            const price = knownA / bPerA;
            const incumbent = best.get(keyB);
            if (price > 0 && Number.isFinite(price) && (!incumbent || liquidity > incumbent.liquidity)) {
              best.set(keyB, { price, liquidity });
            }
          }
        }

        // Price A from B.
        if (knownB !== undefined && knownA === undefined) {
          const bPerA = v2SpotPrice(pool, true);
          if (bPerA > 0) {
            const price = knownB * bPerA;
            const incumbent = best.get(keyA);
            if (price > 0 && Number.isFinite(price) && (!incumbent || liquidity > incumbent.liquidity)) {
              best.set(keyA, { price, liquidity });
            }
          }
        }
      }

      for (const [address, { price }] of best) {
        derived.set(address, price);
      }
    }

    // Keep hint-based fallbacks for anything we could not derive.
    for (const token of this.chain.tokens) {
      const address = this.key(token.address);
      if (!derived.has(address)) {
        const fallback = token.stable ? 1 : token.usdHint;
        if (fallback) derived.set(address, fallback);
      }
    }

    this.prices = derived;
    this.lastUpdated = Date.now();

    log.debug('prices refreshed', {
      chain: this.chain.name,
      native: this.nativeUsd(),
      tokens: [...derived.entries()].length,
    });
  }

  /** USD price for a token, or 0 when unknown. */
  usd(token: TokenInfo): number {
    return this.prices.get(this.key(token.address)) ?? (token.stable ? 1 : 0);
  }

  /** USD price of the chain's native gas token. */
  nativeUsd(): number {
    return this.prices.get(this.key(this.chain.wrappedNative)) ?? 0;
  }

  get updatedAt(): number {
    return this.lastUpdated;
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const token of this.chain.tokens) {
      out[token.symbol] = Number(this.usd(token).toPrecision(8));
    }
    return out;
  }
}
