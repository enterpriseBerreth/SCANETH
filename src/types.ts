/**
 * ARBO shared types.
 */

/**
 * `simulate` — scan and score only, nothing recorded.
 * `paper`    — scan, then settle each candidate against fresh on-chain state
 *              after a delay and book the result to a persistent ledger.
 * `live`     — real transactions.
 */
export type Mode = 'simulate' | 'paper' | 'live';

export type ChainName = 'base' | 'arbitrum' | 'optimism' | 'ethereum';

/** Which on-chain protocol family a pool/router belongs to. */
export type DexKind = 'univ2' | 'univ3' | 'solidly' | 'curve';

/** Flash-loan liquidity source. Must match the enum in ArboFlashArb.sol. */
export enum FlashProvider {
  Aave = 0,
  Balancer = 1,
}

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  /** Rough USD reference price, used only for notional sizing and gas costing. */
  usdHint?: number;
  /** True for USD-pegged stablecoins; lets us price notionals without an oracle. */
  stable?: boolean;
}

export interface DexVenue {
  /** Stable identifier, e.g. "uniswap-v3". */
  id: string;
  label: string;
  kind: DexKind;
  /** Router used for execution. */
  router: string;
  /** Factory, used by univ2/solidly to derive pair addresses. */
  factory?: string;
  /** QuoterV2, used by univ3 for quoting. */
  quoter?: string;
  /** Swap fee in basis points. univ2 only — univ3/solidly carry fee per pool. */
  feeBps?: number;
  /** Fee tiers to probe. univ3 only. */
  feeTiers?: number[];
  /**
   * Curve pool addresses to scan, explicit rather than derived. Curve has no
   * canonical pair-lookup: registries disagree across deployments and pools are
   * multi-asset, so enumerating them is guesswork. Naming them is honest.
   */
  curvePools?: string[];
}

export interface ChainConfig {
  name: ChainName;
  chainId: number;
  label: string;
  /** Native gas token, used to convert gas units into USD. */
  nativeSymbol: string;
  /** Wrapped native token — also the primary flash-loan asset. */
  wrappedNative: string;
  multicall3: string;
  aavePool?: string;
  balancerVault?: string;
  venues: DexVenue[];
  tokens: TokenInfo[];
  /** Token pairs to scan, referenced by symbol. */
  pairs: Array<[string, string]>;
}

/** One hop of an arbitrage route. */
export interface RouteLeg {
  venueId: string;
  kind: DexKind;
  router: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  /** univ3 pool fee tier; 0 for everything else. */
  feeTier: number;
  /** Swap fee in basis points. Per-venue for univ2, per-pool for univ3/solidly. */
  feeBps: number;
  /** Pool address, captured at quote time. */
  pool?: string;
  /** Reserves captured at quote time, used for free local re-pricing. */
  reserveIn?: bigint;
  reserveOut?: bigint;

  // ── solidly ───────────────────────────────────────────────────────────────
  /**
   * True for a Solidly stable pool, which prices on `x³y + y³x = k` rather than
   * `x·y = k`. Getting this wrong does not error — it silently returns a plausible
   * but incorrect quote, so it is carried explicitly on every leg.
   */
  stable?: boolean;
  /** 10**decimals of tokenIn, needed to normalise the stable curve to 1e18. */
  scaleIn?: bigint;
  /** 10**decimals of tokenOut. */
  scaleOut?: bigint;

  // ── curve ─────────────────────────────────────────────────────────────────
  /** Coin index of tokenIn within the Curve pool. */
  curveIndexIn?: number;
  /** Coin index of tokenOut within the Curve pool. */
  curveIndexOut?: number;
  /** Whether the pool exposes `get_dy(int128,int128,uint256)` vs the uint variant. */
  curveInt128?: boolean;
}

export interface ArbOpportunity {
  id: string;
  chain: ChainName;
  /** Asset borrowed via flash loan and repaid at the end of the cycle. */
  baseToken: TokenInfo;
  legs: RouteLeg[];
  /** Chosen flash-loan size, in baseToken units. */
  amountIn: bigint;
  /** Expected output of the full cycle, in baseToken units. */
  amountOut: bigint;
  /** amountOut - amountIn - flashFee, in baseToken units. Can be negative. */
  grossProfit: bigint;
  flashFee: bigint;
  flashProvider: FlashProvider;
  notionalUsd: number;
  grossProfitUsd: number;
  /** Gas units modelled from this route's actual shape, not a flat constant. */
  gasUnits: bigint;
  gasCostUsd: number;
  /** The number that actually matters. */
  netProfitUsd: number;
  discoveredAt: number;
}

export interface CexSpread {
  symbol: string;
  buyVenue: string;
  sellVenue: string;
  buyPrice: number;
  sellPrice: number;
  /** Raw spread before costs. */
  grossBps: number;
  /** After taker fees on both sides and assumed transfer cost. */
  netBps: number;
  /** Depth-limited size available at the quoted prices, in quote currency. */
  availableUsd: number;
  discoveredAt: number;
}

/**
 * A concrete CEX-DEX round trip. Direction is always expressed from the
 * perspective of the on-chain token: if `buyOnDex` is true, the bot buys the
 * token on the DEX and sells it on the CEX; the CEX balance is assumed to
 * already contain the token (or be withdrawable). If false, the bot sells token
 * on DEX for stable and buys it back cheaper on CEX.
 */
export interface CexDexOpportunity {
  id: string;
  chain: ChainName;
  symbol: string;
  cex: string;
  baseToken: TokenInfo;
  quoteToken: TokenInfo;
  /** True when the DEX leg is a buy; false when it is a sell. */
  buyOnDex: boolean;
  /** CEX price of one base token in quote currency. */
  cexPrice: number;
  /** DEX price of one base token in quote currency after price impact. */
  dexPrice: number;
  /** Size in base-token units. */
  amountBase: bigint;
  /** Size in quote currency at the entry price. */
  notionalUsd: number;
  cexFeeUsd: number;
  dexFeeUsd: number;
  transferCostUsd: number;
  slippageCostUsd: number;
  gasCostUsd: number;
  /** Expected net profit in USD after all costs. */
  netProfitUsd: number;
  discoveredAt: number;
}

export interface ExecutionResult {
  opportunityId: string;
  submitted: boolean;
  txHash?: string;
  /** Why it was not submitted, when submitted === false. */
  reason?: string;
  realisedProfitUsd?: number;
  gasSpentUsd?: number;
}

/** Result of attempting one CEX-DEX round trip. */
export interface CexDexExecutionResult {
  opportunityId: string;
  submitted: boolean;
  /** 'paper' | 'live' outcome classification. */
  outcome: 'filled' | 'reverted' | 'skipped' | 'failed';
  reason?: string;
  cexOrderId?: string;
  dexTxHash?: string;
  realisedProfitUsd?: number;
  gasSpentUsd?: number;
  capitalBeforeUsd: number;
  capitalAfterUsd: number;
  completedAt: number;
}
