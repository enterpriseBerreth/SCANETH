/**
 * SCANETH block scanner.
 *
 * Watches every Ethereum block for new DEX pairs (Uniswap V2, SushiSwap V2,
 * Uniswap V3). For each newly-paired token it queries DEXScreener to enrich
 * the launch with age, transaction counts, buys/sells, liquidity and market
 * cap. Alerts are only emitted when the configured filters pass.
 */

import { Interface, type Log, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { DEX_FACTORIES, QUOTE_TOKENS } from './constants';
import type { ScanStats, TokenLaunch } from './types';
import { analyzeToken, formatAlert, shouldAlert } from './analyzer';
import { fetchTokenPairs, formatAge, pairAgeMs, pickBestPair } from './dexscreener';
import { checkSafety } from './safety';

const log = createLogger('scaneth:scanner');

const PAIR_CREATED_IFACE = new Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
]);
const POOL_CREATED_IFACE = new Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);

export interface ScanResult {
  launches: TokenLaunch[];
  alerts: TokenLaunch[];
  stats: ScanStats;
}

export interface ScanFilters {
  /** Max pair age in hours to consider. */
  maxAgeHours: number;
  /** Minimum transactions in the past hour. */
  minH1Txns: number;
  /** Minimum sells in the past hour. */
  minH1Sells: number;
  /** Max risk score (0-100) to alert. */
  maxRiskScore: number;
  /** Max safety/rug score (0-100) to alert. */
  maxSafetyScore: number;
  /** Simulated probe size in ETH. */
  probeEth: number;
  /** Max acceptable round-trip tax in bps. */
  maxTaxBps: number;
  /** Reject if top holder exceeds this %. */
  maxTopHolderPct: number;
}

export class BlockScanner {
  private readonly seen = new Set<string>();
  private stats: ScanStats = {
    blocksProcessed: 0,
    pairsDetected: 0,
    tokensIdentified: 0,
    launchesDetected: 0,
    alertsSent: 0,
    dexScreenerHits: 0,
    dexScreenerMisses: 0,
    lastBlockNumber: 0,
    lastBlockAt: 0,
  };

  constructor(
    private readonly provider: Provider,
    private readonly filters: ScanFilters,
  ) {}

  getStats(): ScanStats {
    return { ...this.stats };
  }

  async processBlock(blockNumber: number): Promise<ScanResult> {
    const startedAt = Date.now();
    const result: ScanResult = {
      launches: [],
      alerts: [],
      stats: this.stats,
    };

    try {
      const logs = await this.provider.getLogs({ fromBlock: blockNumber, toBlock: blockNumber });

      this.stats.lastBlockNumber = blockNumber;
      this.stats.lastBlockAt = Date.now();
      this.stats.blocksProcessed += 1;

      const newPairs = this.extractNewPairs(logs);
      this.stats.pairsDetected += newPairs.length;

      for (const { tokenAddress, dex, pairAddress, txHash } of newPairs) {
        if (this.seen.has(tokenAddress)) continue;
        this.seen.add(tokenAddress);

        try {
          const launch = await this.buildLaunch(tokenAddress, dex, pairAddress, txHash, blockNumber);
          if (!launch) continue;

          this.stats.tokensIdentified += 1;
          if (launch.dexScreener) {
            this.stats.dexScreenerHits += 1;
            this.stats.launchesDetected += 1;
            result.launches.push(launch);

            if (shouldAlert(launch, this.filters)) {
              result.alerts.push(launch);
              this.stats.alertsSent += 1;
            }
          } else {
            this.stats.dexScreenerMisses += 1;
          }
        } catch (err) {
          log.debug('token analysis failed', { address: tokenAddress, ...errMeta(err) });
        }
      }

      log.info('block scanned', {
        blockNumber,
        pairs: newPairs.length,
        launches: result.launches.length,
        alerts: result.alerts.length,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } catch (err) {
      log.error('block scan failed', { blockNumber, ...errMeta(err) });
      return result;
    }
  }

  /**
   * Scan a historical range. Useful for backtesting.
   */
  async scanRange(fromBlock: number, toBlock: number): Promise<ScanResult> {
    const merged: ScanResult = { launches: [], alerts: [], stats: this.stats };
    for (let b = fromBlock; b <= toBlock; b++) {
      const r = await this.processBlock(b);
      merged.launches.push(...r.launches);
      merged.alerts.push(...r.alerts);
    }
    return merged;
  }

  private extractNewPairs(
    logs: Log[],
  ): Array<{ tokenAddress: string; dex: string; pairAddress: string; txHash: string }> {
    const out: Array<{ tokenAddress: string; dex: string; pairAddress: string; txHash: string }> = [];

    for (const logEntry of logs) {
      const address = logEntry.address.toLowerCase();

      // Uniswap V2 / SushiSwap V2 PairCreated.
      for (const [dex, factory] of Object.entries(DEX_FACTORIES)) {
        if (dex === 'uniswap-v3') continue;
        if (address !== factory.address.toLowerCase()) continue;
        try {
          const parsed = PAIR_CREATED_IFACE.parseLog(logEntry);
          if (!parsed) continue;
          const t0 = String(parsed.args.token0).toLowerCase();
          const t1 = String(parsed.args.token1).toLowerCase();
          const tokenAddress = this.identifyNewToken(t0, t1);
          if (!tokenAddress) continue;
          out.push({
            tokenAddress,
            dex,
            pairAddress: String(parsed.args.pair),
            txHash: logEntry.transactionHash,
          });
        } catch {
          // ignore parse failures
        }
      }

      // Uniswap V3 PoolCreated.
      if (address === DEX_FACTORIES['uniswap-v3'].address.toLowerCase()) {
        try {
          const parsed = POOL_CREATED_IFACE.parseLog(logEntry);
          if (!parsed) continue;
          const t0 = String(parsed.args.token0).toLowerCase();
          const t1 = String(parsed.args.token1).toLowerCase();
          const tokenAddress = this.identifyNewToken(t0, t1);
          if (!tokenAddress) continue;
          out.push({
            tokenAddress,
            dex: 'uniswap-v3',
            pairAddress: String(parsed.args.pool),
            txHash: logEntry.transactionHash,
          });
        } catch {
          // ignore parse failures
        }
      }
    }

    return out;
  }

  /**
   * Given a pair's two tokens, return the one that is NOT a common quote asset.
   * If both are quote assets, the pair is not a new token launch.
   */
  private identifyNewToken(t0: string, t1: string): string | null {
    const t0IsQuote = QUOTE_TOKENS.has(t0);
    const t1IsQuote = QUOTE_TOKENS.has(t1);

    if (t0IsQuote && t1IsQuote) return null;
    if (!t0IsQuote && !t1IsQuote) return null; // neither is a quote — ignore ambiguous pairs
    return t0IsQuote ? t1 : t0;
  }

  private async buildLaunch(
    tokenAddress: string,
    dex: string,
    pairAddress: string,
    txHash: string,
    blockNumber: number,
  ): Promise<TokenLaunch | null> {
    const [risk, metadata, pairs, safety] = await Promise.all([
      analyzeToken(this.provider, tokenAddress, ''),
      import('./analyzer').then((m) => m.readTokenMetadata(this.provider, tokenAddress)),
      fetchTokenPairs(tokenAddress),
      checkSafety({
        provider: this.provider,
        tokenAddress,
        pairAddress,
        dex,
        probeEth: this.filters.probeEth,
        maxTaxBps: this.filters.maxTaxBps,
        maxTopHolderPct: this.filters.maxTopHolderPct,
      }),
    ]);

    const bestPair = pickBestPair(pairs, tokenAddress);
    let dexScreener: TokenLaunch['dexScreener'];

    if (bestPair) {
      const ageMs = pairAgeMs(bestPair);
      const h1 = bestPair.txns?.h1;
      const h1Txns = h1 ? h1.buys + h1.sells : 0;
      const h1Buys = h1?.buys ?? 0;
      const h1Sells = h1?.sells ?? 0;
      const totalTxns =
        (bestPair.txns?.m5 ? bestPair.txns.m5.buys + bestPair.txns.m5.sells : 0) +
        (bestPair.txns?.h1 ? bestPair.txns.h1.buys + bestPair.txns.h1.sells : 0) +
        (bestPair.txns?.h6 ? bestPair.txns.h6.buys + bestPair.txns.h6.sells : 0) +
        (bestPair.txns?.h24 ? bestPair.txns.h24.buys + bestPair.txns.h24.sells : 0);

      dexScreener = {
        pair: bestPair,
        ageMs: ageMs ?? 0,
        h1Txns,
        h1Buys,
        h1Sells,
        totalTxns,
      };
    }

    return {
      id: `${tokenAddress}-${blockNumber}`,
      blockNumber,
      discoveredAt: Date.now(),
      tokenAddress,
      metadata,
      dexScreener,
      risk,
      safety,
    };
  }
}
