/**
 * SCANETH shared types.
 *
 * SCANETH = Smart Contract Analyzer for New Ethereum Tokens.
 * Watches Ethereum for freshly-created DEX pairs, enriches them with
 * DEXScreener data, and alerts when on-chain + DEXScreener filters match.
 */

import type { DexScreenerPair } from './dexscreener';
import type { SafetyReport } from './safety';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export interface TokenLaunch {
  /** Unique opportunity id. */
  id: string;
  /** Block where the pair was created. */
  blockNumber: number;
  /** Exact timestamp the launch was observed. */
  discoveredAt: number;
  /** Contract address of the ERC-20 token. */
  tokenAddress: string;
  /** Human-readable token metadata. */
  metadata: TokenMetadata;
  /** DEX pair data from DEXScreener. */
  dexScreener?: DexScreenerEnrichment;
  /** Risk evaluation result. */
  risk: RiskReport;
  /** On-chain safety / rug-pull report. */
  safety: SafetyReport;
}

export interface DexScreenerEnrichment {
  pair: DexScreenerPair;
  /** Age of the pair in milliseconds. */
  ageMs: number;
  /** Transactions in the past hour. */
  h1Txns: number;
  /** Buys in the past hour. */
  h1Buys: number;
  /** Sells in the past hour. */
  h1Sells: number;
  /** Total transactions across all buckets. */
  totalTxns: number;
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  /** True when all three metadata reads succeeded. */
  complete: boolean;
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
  pairsDetected: number;
  tokensIdentified: number;
  launchesDetected: number;
  alertsSent: number;
  dexScreenerHits: number;
  dexScreenerMisses: number;
  lastBlockNumber: number;
  lastBlockAt: number;
}
