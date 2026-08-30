/**
 * SCANETH shared types.
 *
 * SCANETH = Smart Contract Analyzer for New Ethereum Tokens.
 * A research-only bot that watches Ethereum for freshly-deployed ERC-20 tokens,
 * scores them for common risk patterns, and alerts on low-risk launches.
 */

export type Mode = 'scan' | 'simulate';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export interface TokenLaunch {
  /** Unique opportunity id. */
  id: string;
  /** Block where the token contract was created. */
  blockNumber: number;
  /** Exact timestamp the launch was observed. */
  discoveredAt: number;
  /** Deployer / creator EOA or contract. */
  deployer: string;
  /** Contract address of the ERC-20 token. */
  tokenAddress: string;
  /** Human-readable token metadata. */
  metadata: TokenMetadata;
  /** Liquidity events detected in the same block window. */
  liquidity: LiquidityEvent[];
  /** Risk evaluation result. */
  risk: RiskReport;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** True when all three metadata reads succeeded. */
  complete: boolean;
}

export interface LiquidityEvent {
  /** DEX where liquidity was added. */
  dex: 'uniswap-v2' | 'uniswap-v3' | 'sushiswap-v2' | 'unknown';
  /** Pair or pool address. */
  poolAddress: string;
  /** Base token of the pair (usually WETH or a stablecoin). */
  quoteToken: string;
  /** Token being paired with the quote. */
  tokenAddress: string;
  /** Transaction hash of the liquidity addition. */
  txHash: string;
  /** Block number of the liquidity addition. */
  blockNumber: number;
  /** Whether the LP tokens were burned/locked in the same transaction. */
  lpLockedOrBurned: boolean;
}

export interface RiskReport {
  /** 0 (safest) to 100 (most dangerous). */
  score: number;
  /** Human-readable classification. */
  tier: RiskTier;
  /** Individual findings that contributed to the score. */
  findings: RiskFinding[];
}

export interface RiskFinding {
  /** Stable machine-readable key. */
  key: string;
  /** Short human-readable description. */
  label: string;
  /** How many points this finding added to the score. */
  points: number;
  /** Whether this finding is considered severe regardless of points. */
  critical: boolean;
}

export interface ScanStats {
  blocksProcessed: number;
  contractsCreated: number;
  tokensIdentified: number;
  launchesDetected: number;
  alertsSent: number;
  lastBlockNumber: number;
  lastBlockAt: number;
}
