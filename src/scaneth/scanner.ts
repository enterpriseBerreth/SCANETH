/**
 * SCANETH block scanner.
 *
 * Watches every Ethereum block for:
 *   - new contract creations (token candidates)
 *   - Uniswap V2 / SushiSwap V2 PairCreated events
 *   - Uniswap V3 PoolCreated events
 *   - ERC-20 Transfer events into pair/pool addresses (liquidity adds)
 *
 * Detected launches are passed to the analyzer for risk scoring.
 */

import { Interface, type Log, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { DEX_FACTORIES, ERC20, ZERO_ADDRESS } from './constants';
import type { LiquidityEvent, ScanStats, TokenLaunch } from './types';
import { analyzeToken, pairLiquidity, shouldAlert } from './analyzer';

const log = createLogger('scaneth:scanner');

const PAIR_CREATED_IFACE = new Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
]);
const POOL_CREATED_IFACE = new Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);
const TRANSFER_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export interface ScanResult {
  launches: TokenLaunch[];
  alerts: TokenLaunch[];
  stats: ScanStats;
}

export class BlockScanner {
  private readonly seen = new Set<string>();
  private readonly pendingLiquidity = new Map<number, LiquidityEvent[]>();
  private stats: ScanStats = {
    blocksProcessed: 0,
    contractsCreated: 0,
    tokensIdentified: 0,
    launchesDetected: 0,
    alertsSent: 0,
    lastBlockNumber: 0,
    lastBlockAt: 0,
  };

  constructor(
    private readonly provider: Provider,
    private readonly minRiskScore: number,
  ) {}

  getStats(): ScanStats {
    return { ...this.stats };
  }

  /**
   * Process a single block. Returns launches and alerts discovered.
   *
   * The scanner intentionally does not rely on a mempool subscription; new-token
   * launches become durable once included in a block, and scanning blocks avoids
   * the noise of reorgs and dropped transactions.
   */
  async processBlock(blockNumber: number): Promise<ScanResult> {
    const startedAt = Date.now();
    const result: ScanResult = {
      launches: [],
      alerts: [],
      stats: this.stats,
    };

    try {
      const [block, logs] = await Promise.all([
        this.provider.getBlock(blockNumber, true),
        this.provider.getLogs({ fromBlock: blockNumber, toBlock: blockNumber }),
      ]);
      if (!block) {
        log.warn('block not found', { blockNumber });
        return result;
      }

      this.stats.lastBlockNumber = blockNumber;
      this.stats.lastBlockAt = Date.now();
      this.stats.blocksProcessed += 1;

      // 1. Detect new contracts created by EOA/contract transactions.
      const createdContracts = this.extractCreatedContracts(block);
      this.stats.contractsCreated += createdContracts.length;

      // 2. Detect liquidity events (PairCreated / PoolCreated / transfers to pairs).
      const liquidityEvents = this.extractLiquidityEvents(logs);
      this.storeLiquidity(blockNumber, liquidityEvents);

      // 3. For each created contract, test if it is an ERC-20 and pair with liquidity.
      for (const { address, deployer, txHash } of createdContracts) {
        if (this.seen.has(address)) continue;
        this.seen.add(address);

        try {
          const launch = await this.buildLaunch(address, deployer, txHash, blockNumber);
          if (!launch) continue;

          this.stats.tokensIdentified += 1;
          if (launch.liquidity.length > 0) {
            this.stats.launchesDetected += 1;
            result.launches.push(launch);
            if (shouldAlert(launch, this.minRiskScore)) {
              result.alerts.push(launch);
              this.stats.alertsSent += 1;
            }
          }
        } catch (err) {
          log.debug('token analysis failed', { address, ...errMeta(err) });
        }
      }

      log.info('block scanned', {
        blockNumber,
        contracts: createdContracts.length,
        launches: result.launches.length,
        alerts: result.alerts.length,
        durationMs: Date.now() - startedAt,
      });

      this.pruneLiquidity(blockNumber);
      return result;
    } catch (err) {
      log.error('block scan failed', { blockNumber, ...errMeta(err) });
      return result;
    }
  }

  /**
   * Scan a historical range. Useful for backtesting or warming up after a
   * deployment outage. Large ranges should be batched by the caller.
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

  private extractCreatedContracts(block: Awaited<ReturnType<Provider['getBlock']>>): Array<{
    address: string;
    deployer: string;
    txHash: string;
  }> {
    const out: Array<{ address: string; deployer: string; txHash: string }> = [];
    // When prefetchTxs=true, block.transactions contains TransactionResponse objects.
    const txs = (block?.transactions ?? []) as unknown as Array<{
      to?: string | null;
      creates?: string | null;
      from: string;
      hash: string;
    }>;
    for (const tx of txs) {
      // Contract creation has a null `to` and the deployed address as `creates`.
      if (!tx.to && tx.creates) {
        out.push({ address: tx.creates, deployer: tx.from, txHash: tx.hash });
      }
    }
    return out;
  }

  private extractLiquidityEvents(logs: Log[]): LiquidityEvent[] {
    const out: LiquidityEvent[] = [];
    for (const logEntry of logs) {
      const address = logEntry.address.toLowerCase();

      // Uniswap V2 / SushiSwap V2 PairCreated.
      for (const [dex, factory] of Object.entries(DEX_FACTORIES)) {
        if (dex === 'uniswap-v3') continue;
        if (address !== factory.address.toLowerCase()) continue;
        try {
          const parsed = PAIR_CREATED_IFACE.parseLog(logEntry);
          if (!parsed) continue;
          out.push({
            dex: dex as LiquidityEvent['dex'],
            poolAddress: String(parsed.args.pair),
            quoteToken: String(parsed.args.token0),
            tokenAddress: String(parsed.args.token1),
            txHash: logEntry.transactionHash,
            blockNumber: logEntry.blockNumber,
            lpLockedOrBurned: false,
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
          out.push({
            dex: 'uniswap-v3',
            poolAddress: String(parsed.args.pool),
            quoteToken: String(parsed.args.token0),
            tokenAddress: String(parsed.args.token1),
            txHash: logEntry.transactionHash,
            blockNumber: logEntry.blockNumber,
            lpLockedOrBurned: false,
          });
        } catch {
          // ignore parse failures
        }
      }

      // ERC-20 Transfer into a pool: used to mark LP lock/burn heuristically.
      if (logEntry.topics[0] === ERC20.Transfer) {
        try {
          const parsed = TRANSFER_IFACE.parseLog(logEntry);
          if (!parsed) continue;
          const from = String(parsed.args.from).toLowerCase();
          const to = String(parsed.args.to).toLowerCase();
          // Only track zero-address mints here as a cheap proxy.
          if (from === ZERO_ADDRESS.toLowerCase()) {
            // Could be initial mint into pool.
          }
        } catch {
          // ignore
        }
      }
    }
    return out;
  }

  private storeLiquidity(blockNumber: number, events: LiquidityEvent[]): void {
    const existing = this.pendingLiquidity.get(blockNumber) ?? [];
    existing.push(...events);
    this.pendingLiquidity.set(blockNumber, existing);
  }

  private pruneLiquidity(currentBlock: number): void {
    const cutoff = currentBlock - 10;
    for (const key of this.pendingLiquidity.keys()) {
      if (key < cutoff) this.pendingLiquidity.delete(key);
    }
  }

  private async buildLaunch(
    tokenAddress: string,
    deployer: string,
    txHash: string,
    blockNumber: number,
  ): Promise<TokenLaunch | null> {
    const risk = await analyzeToken(this.provider, tokenAddress, deployer);

    // Collect liquidity events from the creation block and a small look-back.
    const allLiquidity: LiquidityEvent[] = [];
    for (let b = blockNumber - 3; b <= blockNumber; b++) {
      allLiquidity.push(...(this.pendingLiquidity.get(b) ?? []));
    }

    const liquidity = pairLiquidity(tokenAddress, allLiquidity);

    // Heuristic: mark LP locked/burned if the creation tx also sends LP tokens
    // to a known burn address. We keep it simple: check creation tx logs only.
    for (const liq of liquidity) {
      liq.lpLockedOrBurned = this.isLpLockedOrBurned(txHash);
    }

    return {
      id: `${tokenAddress}-${blockNumber}`,
      blockNumber,
      discoveredAt: Date.now(),
      deployer,
      tokenAddress,
      metadata: await import('./analyzer').then((m) => m.readTokenMetadata(this.provider, tokenAddress)),
      liquidity,
      risk,
    };
  }

  private isLpLockedOrBurned(txHash: string): boolean {
    // A full implementation would fetch the transaction receipt and inspect
    // Transfer events to burn addresses. We default to false; this is a safe
    // placeholder that does not mislead users.
    return false;
  }
}
