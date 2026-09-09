import { type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import type { ScanethConfig } from '../config';
import type { ScanethNotifier } from './notifier';
import type { CopyTrader } from './copytrader';

const log = createLogger('scaneth:wallet-scout');

const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const APPROVE_SELECTOR = '0x095ea7b3';
/** Skip wallets that are almost certainly contracts/bots with noisy behavior. */
const MIN_TX_VALUE_ETH = 0.005;

interface CandidateScore {
  wallet: string;
  pnlPct: number;
  roundTrips: number;
}

export interface ScoutStats {
  enabled: boolean;
  lastRunAt: number | null;
  lastRunAdded: string[];
  lastRunRemoved: string[];
  totalAdded: number;
  totalRemoved: number;
  running: boolean;
}

/**
 * Auto-scout engine.
 *
 * Periodically discovers wallets that are profitably trading hot ETH tokens,
 * evaluates them from on-chain round trips (ETH spent buying vs ETH received
 * selling), and swaps out the worst-performing watched wallets.
 */
export class WalletScout {
  private timer?: NodeJS.Timeout;
  private runningCycle = false;
  private lastRunAt: number | null = null;
  private lastRunAdded: string[] = [];
  private lastRunRemoved: string[] = [];
  private totalAdded = 0;
  private totalRemoved = 0;

  constructor(
    private readonly config: ScanethConfig,
    private readonly provider: Provider,
    private readonly notifier: ScanethNotifier,
    private readonly copytrader: CopyTrader,
  ) {}

  start(): void {
    if (!this.config.copytraderAutoScoutEnabled) return;
    // Warm up: let the paper trader observe some activity before the first cycle.
    this.timer = setTimeout(() => {
      void this.runCycle();
      this.timer = setInterval(() => void this.runCycle(), this.config.copytraderScoutIntervalHours * 3_600_000);
    }, 10 * 60_000);
    log.info('wallet scout started', { intervalHours: this.config.copytraderScoutIntervalHours });
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getStats(): ScoutStats {
    return {
      enabled: this.config.copytraderAutoScoutEnabled,
      lastRunAt: this.lastRunAt,
      lastRunAdded: this.lastRunAdded,
      lastRunRemoved: this.lastRunRemoved,
      totalAdded: this.totalAdded,
      totalRemoved: this.totalRemoved,
      running: this.runningCycle,
    };
  }

  /** One scout cycle: discover → evaluate → replace worst performers. */
  async runCycle(): Promise<void> {
    if (this.runningCycle) return;
    this.runningCycle = true;
    try {
      log.info('scout cycle starting');
      const candidates = await this.discoverAndEvaluate();
      const changes = this.manageRoster(candidates);
      this.lastRunAt = Date.now();
      this.lastRunAdded = changes.added;
      this.lastRunRemoved = changes.removed;
      if (changes.added.length > 0 || changes.removed.length > 0) {
        this.totalAdded += changes.added.length;
        this.totalRemoved += changes.removed.length;
        await this.notifyChanges(changes);
      }
      log.info('scout cycle done', { candidates: candidates.length, ...changes });
    } catch (err) {
      log.error('scout cycle failed', errMeta(err));
    } finally {
      this.runningCycle = false;
    }
  }

  /** Find hot ETH tokens, extract active traders, evaluate their profitability. */
  private async discoverAndEvaluate(): Promise<CandidateScore[]> {
    const tokens = await this.discoverHotTokens();
    log.info('scout hot tokens', { tokens });

    const watched = new Set(this.copytrader.getWalletPerformance().keys());
    const traderCounts = new Map<string, number>();

    const latest = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - 3_000);

    for (const token of tokens.slice(0, 8)) {
      try {
        const logs = await this.provider.getLogs({
          address: token,
          topics: [TRANSFER_TOPIC],
          fromBlock,
          toBlock: latest,
        });
        for (const lg of logs.slice(0, 2_000)) {
          if (lg.topics.length < 3) continue;
          const topic1 = lg.topics[1];
          const topic2 = lg.topics[2];
          if (!topic1 || !topic2) continue;
          for (const topic of [topic1, topic2]) {
            const addr = '0x' + topic.slice(26).toLowerCase();
            if (addr === token.toLowerCase() || addr === WETH) continue;
            if (watched.has(addr)) continue;
            traderCounts.set(addr, (traderCounts.get(addr) ?? 0) + 1);
          }
        }
      } catch (err) {
        log.debug('token log fetch failed', { token, ...errMeta(err) });
      }
    }

    // Most active traders on hot tokens, excluding contracts.
    const ranked = [...traderCounts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
    const evaluated: CandidateScore[] = [];
    for (const wallet of ranked) {
      if (evaluated.length >= 10) break;
      const code = await this.provider.getCode(wallet);
      if (code !== '0x') continue;

      const score = await this.evaluateCandidate(wallet);
      if (score && score.roundTrips >= 3 && score.pnlPct > 0) {
        evaluated.push({ wallet, ...score });
      }
    }

    evaluated.sort((a, b) => b.pnlPct - a.pnlPct);
    log.info('scout evaluated candidates', { count: evaluated.length });
    return evaluated;
  }

  /** Trending ETH tokens from DexScreener boosts (free endpoint). */
  private async discoverHotTokens(): Promise<string[]> {
    try {
      const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
      if (!r.ok) return [];
      const j = (await r.json()) as { chainId?: string; tokenAddress?: string }[];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of j) {
        if (item.chainId !== 'ethereum' || !item.tokenAddress) continue;
        const addr = item.tokenAddress.toLowerCase();
        if (addr === WETH || seen.has(addr)) continue;
        seen.add(addr);
        out.push(addr);
        if (out.length >= 8) break;
      }
      return out;
    } catch (err) {
      log.debug('hot token discovery failed', errMeta(err));
      return [];
    }
  }

  /**
   * Evaluate a candidate wallet from its recent completed round trips:
   * for each token it bought AND sold recently, compare ETH spent vs ETH
   * received. Returns aggregate PNL% over completed trips.
   */
  private async evaluateCandidate(wallet: string): Promise<{ pnlPct: number; roundTrips: number } | null> {
    const wl = wallet.toLowerCase();
    try {
      const r = await fetch(`${BLOCKSCOUT}/addresses/${wallet}/transactions`, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const j = (await r.json()) as { items?: { hash: string; from?: { hash?: string }; method?: string; raw_input?: string; value?: string }[] };
      const items = j.items ?? [];

      const ethSpent = new Map<string, number>();
      const ethReceived = new Map<string, number>();

      let checked = 0;
      for (const tx of items) {
        if (checked >= 40) break;
        if ((tx.from?.hash ?? '').toLowerCase() !== wl) continue;
        if ((tx.method ?? '') === 'approve' || (tx.raw_input ?? '').startsWith(APPROVE_SELECTOR)) continue;
        const valueEth = Number(BigInt(tx.value ?? '0')) / 1e18;
        checked++;

        const receipt = await this.provider.getTransactionReceipt(tx.hash);
        if (!receipt || receipt.status !== 1) continue;

        // Classify: which non-WETH tokens moved out of the wallet (sold) or
        // into the wallet (bought), and how much ETH/WETH was involved.
        const tokensOut = new Set<string>();
        const tokensIn = new Set<string>();
        let ethOut = valueEth; // native ETH sent with the tx
        let wethToWallet = 0n;
        let wethFromWallet = 0n;
        let unwrapped = 0n;

        for (const lg of receipt.logs) {
          const topic0 = lg.topics[0];
          if (lg.topics.length < 3 || topic0 !== TRANSFER_TOPIC) {
            // WETH Withdrawal event
            if (lg.address.toLowerCase() === WETH && topic0 === '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65') {
              try { unwrapped += BigInt(lg.data); } catch { /* ignore */ }
            }
            continue;
          }
          const t1 = lg.topics[1];
          const t2 = lg.topics[2];
          if (!t1 || !t2) continue;
          const from = '0x' + t1.slice(26).toLowerCase();
          const to = '0x' + t2.slice(26).toLowerCase();
          const token = lg.address.toLowerCase();
          if (token === WETH) {
            if (to === wl) wethToWallet += BigInt(lg.data);
            else if (from === wl) wethFromWallet += BigInt(lg.data);
            continue;
          }
          if (to === wl) tokensIn.add(token);
          else if (from === wl) tokensOut.add(token);
        }

        // Buys: wallet received a token and paid ETH/WETH.
        for (const token of tokensIn) {
          if (tokensOut.has(token)) continue; // token->token swap, skip
          const paid = ethOut + Number(wethFromWallet) / 1e18;
          if (paid >= MIN_TX_VALUE_ETH) {
            ethSpent.set(token, (ethSpent.get(token) ?? 0) + paid);
          }
        }

        // Sells: wallet sent a token and received WETH/ETH.
        for (const token of tokensOut) {
          if (tokensIn.has(token)) continue;
          const got = Number(wethToWallet) / 1e18 + Number(unwrapped) / 1e18;
          if (got >= MIN_TX_VALUE_ETH) {
            ethReceived.set(token, (ethReceived.get(token) ?? 0) + got);
          }
        }
      }

      // Completed round trips: tokens with both buys and sells.
      let totalSpent = 0;
      let totalReceived = 0;
      let roundTrips = 0;
      for (const [token, spent] of ethSpent) {
        const received = ethReceived.get(token);
        if (received === undefined || spent <= 0) continue;
        totalSpent += spent;
        totalReceived += received;
        roundTrips++;
      }

      if (roundTrips === 0 || totalSpent <= 0) return null;
      return { pnlPct: ((totalReceived - totalSpent) / totalSpent) * 100, roundTrips };
    } catch (err) {
      log.debug('candidate evaluation failed', { wallet, ...errMeta(err) });
      return null;
    }
  }

  /** Swap the worst watched wallets for better candidates. */
  private manageRoster(candidates: CandidateScore[]): { added: string[]; removed: string[] } {
    const perf = this.copytrader.getWalletPerformance();
    const max = this.config.copytraderMaxWallets;
    const added: string[] = [];
    const removed: string[] = [];

    for (const cand of candidates) {
      if (added.length + perf.size - removed.length >= max) {
        // Roster full: only proceed by replacing the worst performer.
        const worst = this.worstWallet(perf, new Set(removed));
        if (!worst) break;
        const worstPnl = perf.get(worst)!;
        const worstTotal = worstPnl.realizedPnlUsd + worstPnl.unrealizedPnlUsd;
        // Replace only if the worst wallet actually loses money.
        if (worstTotal >= 0) break;
        this.copytrader.removeWatchedWallet(worst);
        removed.push(worst);
      }

      if (this.copytrader.addWatchedWallet(cand.wallet)) {
        added.push(cand.wallet);
      }
    }

    return { added, removed };
  }

  /** Worst watched wallet with at least some observed history. */
  private worstWallet(
    perf: Map<string, { realizedPnlUsd: number; unrealizedPnlUsd: number; trades: number }>,
    exclude: Set<string>,
  ): string | null {
    let worst: string | null = null;
    let worstTotal = 0;
    for (const [wallet, p] of perf) {
      if (exclude.has(wallet) || p.trades < 3) continue; // need history before judging
      const total = p.realizedPnlUsd + p.unrealizedPnlUsd;
      if (worst === null || total < worstTotal) {
        worst = wallet;
        worstTotal = total;
      }
    }
    return worst;
  }

  private async notifyChanges(changes: { added: string[]; removed: string[] }): Promise<void> {
    const lines: string[] = ['<b>SCANETH — Scout roster update</b>', ''];
    if (changes.removed.length > 0) {
      lines.push('<b>Removed (underperforming):</b>');
      for (const w of changes.removed) lines.push(`<code>${w}</code>`);
      lines.push('');
    }
    if (changes.added.length > 0) {
      lines.push('<b>Added (profitable on hot ETH tokens):</b>');
      for (const w of changes.added) lines.push(`<code>${w}</code>`);
    }
    const ok = await this.notifier.sendRaw(lines.join('\n'));
    if (!ok) log.warn('scout roster alert failed');
  }
}
