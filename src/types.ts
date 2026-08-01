/**
 * ARBO shared types.
 */

export type Mode = 'simulate' | 'live';

export type ChainName = 'base' | 'arbitrum' | 'ethereum';

/** Which on-chain protocol family a pool/router belongs to. */
export type DexKind = 'univ2' | 'univ3';

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
  /** Factory, used by univ2 to derive pair addresses. */
  factory?: string;
  /** QuoterV2, used by univ3 for quoting. */
  quoter?: string;
  /** Swap fee in basis points. univ2 only — univ3 carries fee per pool. */
  feeBps?: number;
  /** Fee tiers to probe. univ3 only. */
  feeTiers?: number[];
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
  /** univ3 pool fee tier; 0 for univ2. */
  feeTier: number;
  /** Swap fee in basis points. univ2: venue fee. univ3: feeTier / 100. */
  feeBps: number;
  /** univ2 pool address, captured at quote time. */
  pool?: string;
  /** univ2 reserves captured at quote time, used for free local re-pricing. */
  reserveIn?: bigint;
  reserveOut?: bigint;
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

export interface ExecutionResult {
  opportunityId: string;
  submitted: boolean;
  txHash?: string;
  /** Why it was not submitted, when submitted === false. */
  reason?: string;
  realisedProfitUsd?: number;
  gasSpentUsd?: number;
}
