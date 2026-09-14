/**
 * SCANETH block scanner.
 *
 * Watches every Ethereum block for new DEX pairs (Uniswap V2, SushiSwap V2,
 * Uniswap V3). Alerts are emitted immediately for every newly-paired token
 * with complete on-chain metadata, regardless of buy count or safety score.
 */

import { Interface, type Log, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { DEX_FACTORIES, QUOTE_TOKENS } from './constants';
import type { ScanStats, TokenLaunch } from './types';
import { analyzeToken, formatAlert, shouldAlert } from './analyzer';
import { fetchTokenPairs, pairAgeMs, pickBestPair } from './dexscreener';
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
  /** Simulated probe size in ETH for the safety check. */
  probeEth: number;
  /** Max acceptable round-trip tax in bps for the safety check. */
  maxTaxBps: number;
  /** Flag if top holder exceeds this % for the safety check. */
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

  /**
   * Many launches ship anti-bot protection that blocks sells for the first
   * minutes, then unlocks. A failed sell simulation at the launch block is
   * therefore NOT a final honeypot verdict: failed tokens are re-tested on a
   * delay and alerted if they become sellable. After MAX_RECHECKS failures
   * they are dropped silently.
   */
  private static readonly RECHECK_DELAY_MS = 90_000;
  private static readonly MAX_RECHECKS = 3;
  private readonly recheckQueue = new Map<string, { dex: string; pairAddress: string; txHash: string; blockNumber: number; attempts: number; nextAt: number }>();
  private recheckTimer?: NodeJS.Timeout;

  /** Called when a previously-failed token becomes sellable on a later probe. */
  onLateAlert?: (launch: TokenLaunch) => Promise<void>;

  constructor(
    private readonly provider: Provider,
    private readonly filters: ScanFilters,
  ) {}

  stop(): void {
    if (this.recheckTimer) {
      clearInterval(this.recheckTimer);
      this.recheckTimer = undefined;
    }
  }

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
          this.stats.launchesDetected += 1;
          if (launch.dexScreener) {
            this.stats.dexScreenerHits += 1;
          } else {
            this.stats.dexScreenerMisses += 1;
          }

          result.launches.push(launch);

          if (shouldAlert(launch)) {
            result.alerts.push(launch);
            this.stats.alertsSent += 1;
          } else if (launch.metadata.complete && !launch.safety.sellable && !launch.safety.simulationSkipped) {
            // Sell simulation failed — likely an anti-bot launch window.
            // Re-test later instead of silencing permanently.
            this.scheduleRecheck(tokenAddress, dex, pairAddress, txHash, blockNumber);
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

  private scheduleRecheck(
    tokenAddress: string,
    dex: string,
    pairAddress: string,
    txHash: string,
    blockNumber: number,
  ): void {
    if (this.recheckQueue.has(tokenAddress)) return;
    this.recheckQueue.set(tokenAddress, {
      dex,
      pairAddress,
      txHash,
      blockNumber,
      attempts: 0,
      nextAt: Date.now() + BlockScanner.RECHECK_DELAY_MS,
    });
    if (!this.recheckTimer) {
      this.recheckTimer = setInterval(() => void this.processRechecks(), 30_000);
    }
    log.info('sell sim failed — scheduled recheck', { token: tokenAddress, attemptsMax: BlockScanner.MAX_RECHECKS });
  }

  private async processRechecks(): Promise<void> {
    const now = Date.now();
    const due = [...this.recheckQueue.entries()].filter(([, item]) => item.nextAt <= now);
    for (const [tokenAddress, item] of due) {
      this.recheckQueue.delete(tokenAddress);
      try {
        const fresh = await this.buildLaunch(tokenAddress, item.dex, item.pairAddress, item.txHash, item.blockNumber);
        if (fresh && shouldAlert(fresh)) {
          this.stats.alertsSent += 1;
          log.info('late alert — token became sellable after anti-bot window', {
            token: tokenAddress,
            attempt: item.attempts + 1,
          });
          await this.onLateAlert?.(fresh);
          continue;
        }
        item.attempts += 1;
        if (item.attempts >= BlockScanner.MAX_RECHECKS) {
          log.info('token still fails sell simulation after retries — dropping silently', {
            token: tokenAddress,
            attempts: item.attempts,
          });
          continue;
        }
        item.nextAt = now + BlockScanner.RECHECK_DELAY_MS * (item.attempts + 1);
        this.recheckQueue.set(tokenAddress, item);
      } catch (err) {
        log.debug('sell recheck failed', { token: tokenAddress, ...errMeta(err) });
        item.attempts += 1;
        if (item.attempts < BlockScanner.MAX_RECHECKS) {
          item.nextAt = now + BlockScanner.RECHECK_DELAY_MS;
          this.recheckQueue.set(tokenAddress, item);
        }
      }
    }
  }

  private extractNewPairs(
    logs: Log[],
  ): Array<{ tokenAddress: string; dex: string; pairAddress: string; txHash: string }> {
    const out: Array<{ tokenAddress: string; dex: string; pairAddress: string; txHash: string }> = [];

    for (const logEntry of logs) {
      const address = logEntry.address.toLowerCase();

      // Try to parse any V2-style PairCreated event, regardless of factory address.
      // This catches Uniswap V2 forks and clones that emit the same signature.
      try {
        const parsed = PAIR_CREATED_IFACE.parseLog(logEntry);
        if (parsed) {
          const t0 = String(parsed.args.token0).toLowerCase();
          const t1 = String(parsed.args.token1).toLowerCase();
          const tokenAddress = this.identifyNewToken(t0, t1);
          if (tokenAddress) {
            out.push({
              tokenAddress,
              dex: this.dexNameFromAddress(address, 'v2'),
              pairAddress: String(parsed.args.pair),
              txHash: logEntry.transactionHash,
            });
            continue;
          }
        }
      } catch {
        // not a PairCreated event
      }

      // Try to parse any V3-style PoolCreated event, regardless of factory address.
      try {
        const parsed = POOL_CREATED_IFACE.parseLog(logEntry);
        if (parsed) {
          const t0 = String(parsed.args.token0).toLowerCase();
          const t1 = String(parsed.args.token1).toLowerCase();
          const tokenAddress = this.identifyNewToken(t0, t1);
          if (tokenAddress) {
            out.push({
              tokenAddress,
              dex: this.dexNameFromAddress(address, 'v3'),
              pairAddress: String(parsed.args.pool),
              txHash: logEntry.transactionHash,
            });
            continue;
          }
        }
      } catch {
        // not a PoolCreated event
      }
    }

    return out;
  }

  private dexNameFromAddress(address: string, kind: 'v2' | 'v3'): string {
    for (const [dex, factory] of Object.entries(DEX_FACTORIES)) {
      if (factory.address.toLowerCase() === address) return dex;
    }
    return kind === 'v2' ? 'unknown-v2' : 'unknown-v3';
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
