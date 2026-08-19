/**
 * CEX-DEX opportunity evaluator.
 *
 * Converts a CEX market quote and an on-chain DEX quote into a net-profit
 * round-trip estimate. The direction is chosen to maximise the spread:
 * - If CEX is cheaper than DEX: buy on CEX, sell on DEX (buyOnDex = false)
 * - If CEX is more expensive than DEX: buy on DEX, sell on CEX (buyOnDex = true)
 *
 * Costs included:
 * - CEX taker fee
 * - DEX swap fee + price impact + slippage
 * - Transfer/withdrawal cost
 * - Gas for the on-chain swap
 *
 * Inventory is checked separately by BalanceTracker; this module only prices.
 */
import { Contract, formatUnits, parseUnits } from 'ethers';
import type { ArboConfig } from '../config.js';
import type { ChainContext } from '../onchain/provider.js';
import { UNIV3_QUOTER_V2_ABI, UNIV3_FACTORY_ABI } from '../onchain/abi.js';
import { tokenBySymbol } from '../chains.js';
import type { CexDexOpportunity, ChainName, TokenInfo } from '../types.js';
import type { MarketQuote } from '../cex/adapter.js';

const V3_FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const FEE_TIERS = [100, 500, 3_000, 10_000];
const SWAP_GAS = 180_000n;

/** Find the deepest Uniswap V3 pool for tokenA/tokenB on this chain. */
async function bestV3Pool(
  ctx: ChainContext,
  tokenA: TokenInfo,
  tokenB: TokenInfo,
): Promise<{ pool: string; feeTier: number } | undefined> {
  const factoryAddr = ctx.chain.venues.find((v) => v.id === 'uniswap-v3')?.factory;
  if (!factoryAddr) return undefined;
  const factory = new Contract(factoryAddr, UNIV3_FACTORY_ABI, ctx.provider);

  let bestPool: string | undefined;
  let bestFee = 0;
  for (const fee of FEE_TIERS) {
    try {
      const getPool = factory.getFunction('getPool');
      const pool = (await getPool(tokenA.address, tokenB.address, fee)) as string;
      if (pool && pool !== '0x0000000000000000000000000000000000000000') {
        bestPool = pool;
        bestFee = fee;
      }
    } catch {
      // ignore
    }
  }
  if (!bestPool) return undefined;
  return { pool: bestPool, feeTier: bestFee };
}

/** Quote a single V3 swap. Returns amountOut in tokenOut units. */
async function quoteV3(
  ctx: ChainContext,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: bigint,
  feeTier: number,
): Promise<bigint | undefined> {
  const quoterAddr = ctx.chain.venues.find((v) => v.id === 'uniswap-v3')?.quoter;
  if (!quoterAddr) return undefined;
  const quoter = new Contract(quoterAddr, UNIV3_QUOTER_V2_ABI, ctx.provider);
  try {
    const q = quoter.getFunction('quoteExactInputSingle');
    const result = (await q.staticCall([
      tokenIn.address,
      tokenOut.address,
      amountIn,
      feeTier,
      0n,
    ])) as [bigint, bigint, number, bigint];
    return result[0];
  } catch {
    return undefined;
  }
}

interface EvalInput {
  chain: ChainName;
  symbol: string;
  quoteSymbol: string;
  cex: string;
  cexQuote: MarketQuote;
  cexFeeBps: number;
  gasPriceWei: bigint;
  nativeUsd: number;
}

export async function evaluateCexDex(
  config: ArboConfig,
  ctx: ChainContext,
  input: EvalInput,
): Promise<CexDexOpportunity | undefined> {
  const chain = ctx.chain;
  let baseToken: TokenInfo;
  let quoteToken: TokenInfo;
  try {
    baseToken = tokenBySymbol(chain, input.symbol);
    quoteToken = tokenBySymbol(chain, input.quoteSymbol);
  } catch {
    return undefined;
  }

  const pool = await bestV3Pool(ctx, baseToken, quoteToken);
  if (!pool) return undefined;

  const cexMid = (input.cexQuote.bid + input.cexQuote.ask) / 2;
  if (cexMid <= 0) return undefined;

  // Choose direction: buy where price is lower, sell where price is higher.
  const buyOnDex = input.cexQuote.bid > cexMid * 1.0001; // CEX bid beats DEX mid by ~1bp
  const sellOnDex = !buyOnDex;

  // Size: limited by configured max and available depth.
  const depthUsd = Math.min(
    input.cexQuote.bidVolume * input.cexQuote.bid,
    input.cexQuote.askVolume * input.cexQuote.ask,
    config.cexDexMaxTradeUsd,
  );
  if (depthUsd <= 0) return undefined;

  // Amount of base token to trade.
  const notionalUsd = depthUsd;
  const amountBase = BigInt(
    Math.floor((notionalUsd / cexMid) * 10 ** baseToken.decimals),
  );
  if (amountBase <= 0n) return undefined;

  // DEX quote for the chosen direction.
  const dexAmountOut = buyOnDex
    ? await quoteV3(ctx, quoteToken, baseToken, parseUnits(String(notionalUsd), quoteToken.decimals), pool.feeTier)
    : await quoteV3(ctx, baseToken, quoteToken, amountBase, pool.feeTier);
  if (!dexAmountOut || dexAmountOut <= 0n) return undefined;

  const dexPrice = buyOnDex
    ? notionalUsd / Number(formatUnits(dexAmountOut, baseToken.decimals))
    : Number(formatUnits(dexAmountOut, quoteToken.decimals)) / notionalUsd;

  // Spread in bps from the DEX perspective.
  const spreadBps = buyOnDex
    ? ((input.cexQuote.bid - dexPrice) / dexPrice) * 10_000
    : ((dexPrice - input.cexQuote.ask) / input.cexQuote.ask) * 10_000;

  if (spreadBps < config.cexDexMinSpreadBps) return undefined;

  // Cost accounting.
  const cexFeeUsd = (notionalUsd * input.cexFeeBps) / 10_000;
  const dexFeeUsd = (notionalUsd * pool.feeTier) / 10_000 / 100; // feeTier is hundredths of bps
  const slippageCostUsd = notionalUsd * (config.slippageBps / 10_000);
  const transferCostUsd = config.cexDexWithdrawalCostUsd;
  const gasCostUsd =
    (Number(SWAP_GAS) * Number(input.gasPriceWei)) / 1e18 * input.nativeUsd;

  const grossUsd = Math.abs(
    buyOnDex
      ? (input.cexQuote.bid - dexPrice) * Number(formatUnits(amountBase, baseToken.decimals))
      : (dexPrice - input.cexQuote.ask) * Number(formatUnits(amountBase, baseToken.decimals)),
  );

  const netProfitUsd =
    grossUsd - cexFeeUsd - dexFeeUsd - slippageCostUsd - transferCostUsd - gasCostUsd;

  if (netProfitUsd < config.cexDexMinProfitUsd) return undefined;

  return {
    id: `${input.chain}:${input.symbol}:${Date.now()}`,
    chain: input.chain,
    symbol: input.symbol,
    cex: input.cex,
    baseToken,
    quoteToken,
    buyOnDex,
    cexPrice: buyOnDex ? input.cexQuote.bid : input.cexQuote.ask,
    dexPrice,
    amountBase,
    notionalUsd,
    cexFeeUsd,
    dexFeeUsd,
    transferCostUsd,
    slippageCostUsd,
    gasCostUsd,
    netProfitUsd,
    discoveredAt: Date.now(),
  };
}
