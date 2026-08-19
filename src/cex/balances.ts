/**
 * Balance tracker for CEX-DEX inventory arbitrage.
 *
 * Tracks how much of each asset sits on the CEX versus the on-chain wallet.
 * CEX-DEX arb requires inventory on both sides, so a trade is only possible
 * when the relevant wallet has enough of the token being sold.
 */
import { Contract, formatUnits } from 'ethers';
import type { CexAdapter, BalanceSnapshot } from './adapter.js';
import type { ChainContext } from '../onchain/provider.js';
import type { ChainName, TokenInfo } from '../types.js';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export interface WalletBalances {
  [chain: string]: {
    [symbol: string]: number;
  };
}

export class BalanceTracker {
  private cexBalances: Map<string, BalanceSnapshot> = new Map();
  private walletBalances: WalletBalances = {};

  constructor(
    private readonly cex: CexAdapter,
    private readonly chainContexts: Map<ChainName, ChainContext>,
  ) {}

  async refreshAll(): Promise<void> {
    await this.refreshCex();
    await this.refreshWallets();
  }

  async refreshCex(): Promise<void> {
    // The adapter was initialised with the exchanges configured for CEX-DEX.
    // We refresh each one that loaded successfully.
    for (const id of this.cex['exchanges'].keys()) {
      const bal = await this.cex.balances(id);
      if (bal) this.cexBalances.set(id, bal);
    }
  }

  async refreshWallets(): Promise<void> {
    for (const [chain, ctx] of this.chainContexts) {
      this.walletBalances[chain] = {};
      // Native balance
      try {
        const addr = ctx.wallet?.address;
        if (addr) {
          const nativeBal = await ctx.provider.getBalance(addr);
          this.walletBalances[chain][ctx.chain.nativeSymbol] = Number(formatUnits(nativeBal, 18));
        }
      } catch {
        // No wallet means live mode isn't configured; skip native balance.
      }
    }
  }

  async refreshToken(chain: ChainName, token: TokenInfo): Promise<void> {
    const ctx = this.chainContexts.get(chain);
    if (!ctx) return;
    try {
      const addr = ctx.wallet?.address;
      if (!addr) return;
      const contract = new Contract(token.address, ERC20_ABI, ctx.provider);
      const balanceOf = contract.getFunction('balanceOf');
      const bal = (await balanceOf(addr)) as bigint;
      if (!this.walletBalances[chain]) this.walletBalances[chain] = {};
      this.walletBalances[chain][token.symbol] = Number(formatUnits(bal, token.decimals));
    } catch {
      // Token may not exist on this chain; ignore.
    }
  }

  cexBalance(exchangeId: string, asset: string): number {
    const snap = this.cexBalances.get(exchangeId);
    if (!snap) return 0;
    // ccxt uses uppercase asset symbols.
    return snap[asset.toUpperCase()] ?? snap[asset] ?? 0;
  }

  dexBalance(chain: ChainName, symbol: string): number {
    return this.walletBalances[chain]?.[symbol] ?? 0;
  }

  /**
   * Whether a round trip can be funded. For `buyOnDex=true` we need quote on
   * DEX and base on CEX. For `buyOnDex=false` we need base on DEX and quote
   * on CEX.
   */
  canFund(
    exchangeId: string,
    chain: ChainName,
    baseSymbol: string,
    quoteSymbol: string,
    buyOnDex: boolean,
    notionalUsd: number,
  ): { ok: boolean; reason?: string } {
    if (buyOnDex) {
      const dexQuote = this.dexBalance(chain, quoteSymbol);
      const cexBase = this.cexBalance(exchangeId, baseSymbol);
      if (dexQuote < notionalUsd) {
        return { ok: false, reason: `insufficient ${quoteSymbol} on DEX: $${dexQuote.toFixed(2)}` };
      }
      if (cexBase < notionalUsd / 2) {
        return {
          ok: false,
          reason: `insufficient ${baseSymbol} on CEX: $${(cexBase * 1).toFixed(2)}`,
        };
      }
    } else {
      const dexBase = this.dexBalance(chain, baseSymbol);
      const cexQuote = this.cexBalance(exchangeId, quoteSymbol);
      if (dexBase < notionalUsd) {
        return { ok: false, reason: `insufficient ${baseSymbol} on DEX: $${dexBase.toFixed(2)}` };
      }
      if (cexQuote < notionalUsd / 2) {
        return {
          ok: false,
          reason: `insufficient ${quoteSymbol} on CEX: $${(cexQuote * 1).toFixed(2)}`,
        };
      }
    }
    return { ok: true };
  }
}
