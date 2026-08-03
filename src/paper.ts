/**
 * Paper trading ledger.
 *
 * The purpose of this module is to answer one question honestly: **would this
 * strategy have made money?** That is harder than it sounds, because the default
 * way to build a paper trader is to book the profit you predicted at detection
 * time — which measures the quality of your own optimism, not the market.
 *
 * Arbitrage edges decay in seconds. Between spotting a cycle and landing a
 * transaction, other traders move the pools and the edge you priced is usually
 * gone. So a paper fill here is never the detected number. Every candidate is
 * re-quoted against fresh on-chain state after a deliberate delay, and the
 * *second* number is what gets booked, including gas.
 *
 * What this still cannot model, and you should keep in mind when reading the
 * results:
 *
 * - **Competition.** If an edge survives the delay, this books it as a win. In
 *   reality a searcher with better infrastructure may have taken it first. Real
 *   fill rates are therefore lower than what this reports, never higher.
 * - **Inclusion risk.** A live transaction can be dropped or reordered.
 * - **Ordering within a block.** Settlement quotes at the head of a block; a real
 *   transaction lands somewhere inside it.
 *
 * Those all bias the report *optimistically*, which is the right direction for a
 * measurement whose job is to decide whether to risk real money: if it does not
 * clear here, it certainly will not clear live.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger, errMeta } from './logger';
import type { ArbOpportunity, ChainName, RouteLeg } from './types';

const log = createLogger('paper');

/**
 * `filled`   — the edge survived the delay and cleared the on-chain profit
 *              assertion. Booked as a win.
 * `reverted` — the transaction would have been sent, but the edge decayed below
 *              `minProfit` before inclusion. `ArboFlashArb` reverts at that
 *              point, so the cost is gas only and principal is untouched.
 * `dead`     — the route stopped quoting entirely (drained or paused pool).
 *              Also gas-only: the transaction reverts on the first hop.
 * `skipped`  — expected profit never cleared the floor, so nothing would have
 *              been broadcast. Recorded for decay statistics; costs nothing and
 *              must not move the balance.
 *
 * `decayed` is retained only so ledger entries written before the revert-aware
 * accounting model still parse. Nothing produces it now.
 */
export type PaperOutcome = 'filled' | 'reverted' | 'dead' | 'skipped' | 'decayed';

/**
 * Accounting model version stamped onto every trade.
 *
 * v1 booked the full negative gross on a decayed route. That is a loss the
 * flash-loan contract makes impossible — it reverts before repaying — so v1
 * balances understate live performance. Entries below the current version are
 * kept on disk for reference but are not replayed into the balance.
 */
export const LEDGER_MODEL_VERSION = 2;

export interface PaperTrade {
  kind: 'trade';
  /** Accounting model that produced this row. See LEDGER_MODEL_VERSION. */
  modelVersion?: number;
  id: string;
  chain: ChainName;
  route: string;
  baseSymbol: string;
  /** Human-readable token cycle, e.g. `WETH -> USDC -> WETH`. */
  tokenPath: string;
  notionalUsd: number;

  detectedAt: number;
  expectedGrossUsd: number;
  expectedNetUsd: number;

  settledAt: number;
  settleDelayMs: number;
  gasCostUsd: number;
  actualGrossUsd: number;
  /** The only number that counts: realised gross minus gas. */
  actualNetUsd: number;
  /** Edge lost between detection and settlement, in bps of notional. */
  decayBps: number;

  outcome: PaperOutcome;
  /** Whether this would have cleared MIN_PROFIT_USD and actually been sent live. */
  wouldExecuteLive: boolean;

  /** Simulated account balance immediately before this trade. */
  capitalBeforeUsd: number;
  /** Balance after applying `actualNetUsd`. This is what compounds. */
  capitalAfterUsd: number;
  /** Return on the account for this trade, as a percentage of capital before. */
  pnlPct: number;
}

/**
 * Periodic snapshot of market conditions.
 *
 * Recorded because "zero trades" is otherwise uninterpretable: it looks identical
 * whether the market is efficient or the scanner is broken. This gives the
 * absence of trades an evidence base.
 */
export interface MarketSample {
  kind: 'market';
  at: number;
  chain: ChainName;
  scans: number;
  /** Best net USD across the window. Usually negative, and that is the finding. */
  bestNetUsd: number | null;
  bestEdgeBps: number | null;
  candidatesSeen: number;
}

type LedgerLine = PaperTrade | MarketSample;

export interface PaperStats {
  trades: number;
  filled: number;
  /** Sent but reverted on-chain: gas lost, principal safe. */
  reverted: number;
  dead: number;
  /** Never broadcast — expected profit was below the floor. */
  skipped: number;
  /** Fraction of candidates whose edge survived to settlement. */
  fillRate: number;
  grossUsd: number;
  gasUsd: number;
  /** Cumulative paper P&L. This is the proven-profitability number. */
  netUsd: number;
  /** Balance the account opened with. */
  startingCapitalUsd: number;
  /** Current simulated balance: starting capital plus cumulative net P&L. */
  capitalUsd: number;
  /** Total return on the account since inception, as a percentage. */
  returnPct: number;
  bestUsd: number | null;
  worstUsd: number | null;
  avgNetUsd: number | null;
  avgDecayBps: number | null;
  /** Trades that would have been sent live under the current profit floor. */
  liveEligible: number;
  liveEligibleNetUsd: number;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  perChain: Record<string, { trades: number; netUsd: number }>;
}

/** In-flight candidate awaiting settlement. */
export interface PendingPaperTrade {
  id: string;
  chain: ChainName;
  route: string;
  baseSymbol: string;
  tokenPath: string;
  legs: RouteLeg[];
  amountIn: bigint;
  notionalUsd: number;
  expectedGrossUsd: number;
  expectedNetUsd: number;
  detectedAt: number;
  settleAfter: number;
}

const RECENT_LIMIT = 25;

export class PaperLedger {
  private readonly path: string;
  private readonly minProfitUsd: number;
  private readonly startingCapitalUsd: number;
  /**
   * Simulated balance. Every settled trade moves this, including losses, so the
   * account compounds exactly as a real one would. Gas on a decayed trade is a
   * real debit here — that is the whole point of tracking a balance rather than
   * a bare sum of wins.
   */
  private capitalUsd: number;
  private recent: PaperTrade[] = [];
  private totals = emptyTotals();
  private perChain = new Map<string, { trades: number; netUsd: number }>();
  /** Set once a write fails, so a read-only disk degrades instead of crashing. */
  private writable = true;
  private pending = new Map<string, PendingPaperTrade>();
  private window = new Map<
    ChainName,
    { scans: number; bestNetUsd: number | null; bestEdgeBps: number | null; candidates: number }
  >();

  constructor(path: string, minProfitUsd: number, startingCapitalUsd: number) {
    this.path = path;
    this.minProfitUsd = minProfitUsd;
    this.startingCapitalUsd = startingCapitalUsd;
    this.capitalUsd = startingCapitalUsd;
  }

  get ledgerPath(): string {
    return this.path;
  }

  get capital(): number {
    return this.capitalUsd;
  }

  /**
   * A real account with no money cannot pay gas, so it cannot trade. Reporting
   * fills past this point would be fiction.
   */
  get solvent(): boolean {
    return this.capitalUsd > 0;
  }

  get isWritable(): boolean {
    return this.writable;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Rebuild cumulative state from the ledger file.
   *
   * Totals are recomputed from disk rather than checkpointed separately, so there
   * is exactly one source of truth and a restart can never silently diverge from
   * the recorded history. A missing file is a normal first run, not an error.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') {
        log.info('no existing paper ledger, starting fresh', { path: this.path });
        return;
      }
      log.warn('could not read paper ledger', { path: this.path, ...errMeta(err) });
      return;
    }

    let trades = 0;
    let skipped = 0;
    let legacy = 0;
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      try {
        const entry = JSON.parse(text) as LedgerLine;
        if (entry.kind !== 'trade') continue;

        // Rows written under an older accounting model are not replayed into the
        // balance. v1 booked the full negative gross on a decayed route — a loss
        // the flash-loan contract reverts before it can occur — so replaying them
        // would carry a fictional drawdown forward indefinitely.
        if ((entry.modelVersion ?? 1) < LEDGER_MODEL_VERSION) {
          legacy += 1;
          continue;
        }

        this.accumulate(entry);
        trades += 1;
      } catch {
        // A truncated final line is expected if the process died mid-append.
        skipped += 1;
      }
    }

    if (legacy > 0) {
      log.warn('ignored paper trades from an older accounting model', {
        path: this.path,
        legacyTrades: legacy,
        modelVersion: LEDGER_MODEL_VERSION,
        reason:
          'v1 booked full gross losses on decayed routes; the contract reverts instead, so those balances were not achievable',
      });
    }

    log.info('paper ledger loaded', {
      path: this.path,
      trades,
      legacyIgnored: legacy,
      skippedLines: skipped,
      netUsd: Number(this.totals.netUsd.toFixed(4)),
      capitalUsd: Number(this.capitalUsd.toFixed(4)),
    });
  }

  // ── pending candidates ────────────────────────────────────────────────────

  /**
   * Queue a candidate for settlement later.
   *
   * Deliberately does not book anything yet. Deduplicated by route so a cycle
   * that persists across several scans produces one paper trade rather than an
   * inflated stream of near-duplicates that would flatter the win count.
   */
  open(opportunity: ArbOpportunity, route: string, settleDelayMs: number): boolean {
    const key = `${opportunity.chain}:${route}`;
    if (this.pending.has(key)) return false;

    this.pending.set(key, {
      id: opportunity.id,
      chain: opportunity.chain,
      route,
      baseSymbol: opportunity.baseToken.symbol,
      tokenPath: describeTokenPath(opportunity.legs, opportunity.baseToken.symbol),
      legs: opportunity.legs,
      amountIn: opportunity.amountIn,
      notionalUsd: opportunity.notionalUsd,
      expectedGrossUsd: opportunity.grossProfitUsd,
      expectedNetUsd: opportunity.netProfitUsd,
      detectedAt: opportunity.discoveredAt,
      settleAfter: Date.now() + settleDelayMs,
    });
    return true;
  }

  /** Candidates on `chain` whose settlement delay has elapsed. */
  due(chain: ChainName, now = Date.now()): PendingPaperTrade[] {
    const ready: PendingPaperTrade[] = [];
    for (const entry of this.pending.values()) {
      if (entry.chain === chain && now >= entry.settleAfter) ready.push(entry);
    }
    return ready;
  }

  private dropPending(entry: PendingPaperTrade): void {
    this.pending.delete(`${entry.chain}:${entry.route}`);
  }

  /**
   * Book the outcome of a re-quote. `actualGrossUsd` must come from a fresh
   * quote, never from the detection-time estimate.
   *
   * The accounting mirrors what `ArboFlashArb` would actually do on-chain, which
   * is not the same as "book whatever the re-quote says":
   *
   *  - The contract asserts `balance >= owed + minProfit` *before* repaying and
   *    reverts otherwise. A decayed opportunity therefore never completes at a
   *    loss — the whole transaction unwinds and the only cost is gas.
   *  - So a route that has decayed below the profit floor costs `gasCostUsd`,
   *    not the negative gross. Booking the gross would report a loss the
   *    contract makes structurally impossible, and would make paper results far
   *    worse than live trading could ever be.
   *
   * Candidates whose *expected* profit never cleared the floor are recorded for
   * decay statistics but are marked `skipped`: live, no transaction would have
   * been sent at all, so they must not move the balance.
   */
  async settle(
    entry: PendingPaperTrade,
    result: { actualGrossUsd: number; gasCostUsd: number; quoted: boolean },
  ): Promise<PaperTrade> {
    this.dropPending(entry);

    const settledAt = Date.now();

    // The send decision is made on detection-time expectations, because that is
    // all the bot knows at the moment it would broadcast. Using the settled
    // number here would be hindsight and would flatter the results.
    const wouldSend = entry.expectedNetUsd >= this.minProfitUsd;

    // What the on-chain profit assertion would see.
    const clearsOnChainGuard = result.quoted && result.actualGrossUsd >= this.minProfitUsd;

    let outcome: PaperOutcome;
    let actualNetUsd: number;

    if (!wouldSend) {
      // No transaction, no gas, no balance movement.
      outcome = 'skipped';
      actualNetUsd = 0;
    } else if (!result.quoted) {
      // Route no longer quotes; the transaction would revert on the first hop.
      outcome = 'dead';
      actualNetUsd = -result.gasCostUsd;
    } else if (clearsOnChainGuard) {
      outcome = 'filled';
      actualNetUsd = result.actualGrossUsd - result.gasCostUsd;
    } else {
      // Sent, but the opportunity decayed before inclusion: the contract reverts
      // and only gas is burned. Principal is never at risk.
      outcome = 'reverted';
      actualNetUsd = -result.gasCostUsd;
    }

    // Decay is expressed against notional so it is comparable across trade sizes.
    const decayUsd = entry.expectedGrossUsd - result.actualGrossUsd;
    const decayBps = entry.notionalUsd > 0 ? (decayUsd / entry.notionalUsd) * 10_000 : 0;

    // Only trades that would actually have been broadcast move the balance.
    const capitalBeforeUsd = this.capitalUsd;
    const capitalAfterUsd = capitalBeforeUsd + actualNetUsd;
    const pnlPct = capitalBeforeUsd > 0 ? (actualNetUsd / capitalBeforeUsd) * 100 : 0;

    const trade: PaperTrade = {
      kind: 'trade',
      modelVersion: LEDGER_MODEL_VERSION,
      id: entry.id,
      chain: entry.chain,
      route: entry.route,
      baseSymbol: entry.baseSymbol,
      tokenPath: entry.tokenPath,
      notionalUsd: round(entry.notionalUsd, 2),
      detectedAt: entry.detectedAt,
      expectedGrossUsd: round(entry.expectedGrossUsd, 6),
      expectedNetUsd: round(entry.expectedNetUsd, 6),
      settledAt,
      settleDelayMs: settledAt - entry.detectedAt,
      gasCostUsd: round(outcome === 'skipped' ? 0 : result.gasCostUsd, 6),
      actualGrossUsd: round(result.quoted ? result.actualGrossUsd : 0, 6),
      actualNetUsd: round(actualNetUsd, 6),
      decayBps: round(decayBps, 3),
      outcome,
      wouldExecuteLive: actualNetUsd >= this.minProfitUsd,
      capitalBeforeUsd: round(capitalBeforeUsd, 4),
      capitalAfterUsd: round(capitalAfterUsd, 4),
      pnlPct: round(pnlPct, 4),
    };

    this.accumulate(trade);
    await this.append(trade);
    return trade;
  }

  // ── market conditions ─────────────────────────────────────────────────────

  /** Fold one scan pass into the current rollup window. */
  noteScan(
    chain: ChainName,
    bestNetUsd: number | null,
    bestEdgeBps: number | null,
    candidates: number,
  ): void {
    const current =
      this.window.get(chain) ?? { scans: 0, bestNetUsd: null, bestEdgeBps: null, candidates: 0 };

    current.scans += 1;
    current.candidates += candidates;
    if (bestNetUsd !== null && (current.bestNetUsd === null || bestNetUsd > current.bestNetUsd)) {
      current.bestNetUsd = bestNetUsd;
    }
    if (bestEdgeBps !== null && (current.bestEdgeBps === null || bestEdgeBps > current.bestEdgeBps)) {
      current.bestEdgeBps = bestEdgeBps;
    }
    this.window.set(chain, current);
  }

  /** Persist and reset the rollup window. Called on a timer, not per scan. */
  async flushMarketSamples(): Promise<void> {
    if (this.window.size === 0) return;
    const at = Date.now();

    for (const [chain, w] of this.window) {
      const sample: MarketSample = {
        kind: 'market',
        at,
        chain,
        scans: w.scans,
        bestNetUsd: w.bestNetUsd === null ? null : round(w.bestNetUsd, 6),
        bestEdgeBps: w.bestEdgeBps === null ? null : round(w.bestEdgeBps, 3),
        candidatesSeen: w.candidates,
      };
      await this.append(sample);
    }
    this.window.clear();
  }

  // ── reporting ─────────────────────────────────────────────────────────────

  stats(): PaperStats {
    const t = this.totals;
    const perChain: Record<string, { trades: number; netUsd: number }> = {};
    for (const [chain, v] of this.perChain) {
      perChain[chain] = { trades: v.trades, netUsd: round(v.netUsd, 4) };
    }

    return {
      trades: t.trades,
      filled: t.filled,
      reverted: t.reverted,
      dead: t.dead,
      skipped: t.skipped,
      fillRate: t.trades > 0 ? round(t.filled / t.trades, 4) : 0,
      grossUsd: round(t.grossUsd, 4),
      gasUsd: round(t.gasUsd, 4),
      netUsd: round(t.netUsd, 4),
      startingCapitalUsd: round(this.startingCapitalUsd, 2),
      capitalUsd: round(this.capitalUsd, 4),
      returnPct:
        this.startingCapitalUsd > 0
          ? round(((this.capitalUsd - this.startingCapitalUsd) / this.startingCapitalUsd) * 100, 4)
          : 0,
      bestUsd: t.bestUsd === null ? null : round(t.bestUsd, 4),
      worstUsd: t.worstUsd === null ? null : round(t.worstUsd, 4),
      avgNetUsd: t.trades > 0 ? round(t.netUsd / t.trades, 4) : null,
      avgDecayBps: t.decayCount > 0 ? round(t.decaySum / t.decayCount, 3) : null,
      liveEligible: t.liveEligible,
      liveEligibleNetUsd: round(t.liveEligibleNetUsd, 4),
      firstTradeAt: t.firstTradeAt,
      lastTradeAt: t.lastTradeAt,
      perChain,
    };
  }

  recentTrades(): PaperTrade[] {
    return [...this.recent].reverse();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private accumulate(trade: PaperTrade): void {
    const t = this.totals;
    t.trades += 1;
    t.grossUsd += trade.actualGrossUsd;
    t.gasUsd += trade.gasCostUsd;
    t.netUsd += trade.actualNetUsd;

    // Replay the balance from the recorded value so a reload lands on exactly the
    // number that was written, with no drift from re-deriving it. Ledgers written
    // before capital tracking existed are tolerated by falling back to the delta.
    this.capitalUsd = Number.isFinite(trade.capitalAfterUsd)
      ? trade.capitalAfterUsd
      : this.capitalUsd + trade.actualNetUsd;

    if (trade.outcome === 'filled') t.filled += 1;
    else if (trade.outcome === 'reverted' || trade.outcome === 'decayed') t.reverted += 1;
    else if (trade.outcome === 'skipped') t.skipped += 1;
    else t.dead += 1;

    if (t.bestUsd === null || trade.actualNetUsd > t.bestUsd) t.bestUsd = trade.actualNetUsd;
    if (t.worstUsd === null || trade.actualNetUsd < t.worstUsd) t.worstUsd = trade.actualNetUsd;

    if (Number.isFinite(trade.decayBps)) {
      t.decaySum += trade.decayBps;
      t.decayCount += 1;
    }

    if (trade.wouldExecuteLive) {
      t.liveEligible += 1;
      t.liveEligibleNetUsd += trade.actualNetUsd;
    }

    if (t.firstTradeAt === null || trade.settledAt < t.firstTradeAt) t.firstTradeAt = trade.settledAt;
    if (t.lastTradeAt === null || trade.settledAt > t.lastTradeAt) t.lastTradeAt = trade.settledAt;

    const chainTotals = this.perChain.get(trade.chain) ?? { trades: 0, netUsd: 0 };
    chainTotals.trades += 1;
    chainTotals.netUsd += trade.actualNetUsd;
    this.perChain.set(trade.chain, chainTotals);

    this.recent.push(trade);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
  }

  private async append(entry: LedgerLine): Promise<void> {
    if (!this.writable) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      // A read-only or full disk must not take the bot down; in-memory stats
      // stay correct for this process, only durability is lost.
      this.writable = false;
      log.error('paper ledger write failed, continuing in memory only', {
        path: this.path,
        ...errMeta(err),
      });
    }
  }
}

/**
 * The token cycle as a readable path. Falls back to the base symbol alone if the
 * legs are empty, so an alert never renders as a blank token name.
 */
export function describeTokenPath(legs: RouteLeg[], baseSymbol: string): string {
  if (legs.length === 0) return baseSymbol;
  const symbols = [legs[0]!.tokenIn.symbol, ...legs.map((leg) => leg.tokenOut.symbol)];
  return symbols.join(' -> ');
}

function emptyTotals() {
  return {
    trades: 0,
    filled: 0,
    reverted: 0,
    dead: 0,
    skipped: 0,
    grossUsd: 0,
    gasUsd: 0,
    netUsd: 0,
    bestUsd: null as number | null,
    worstUsd: null as number | null,
    decaySum: 0,
    decayCount: 0,
    liveEligible: 0,
    liveEligibleNetUsd: 0,
    firstTradeAt: null as number | null,
    lastTradeAt: null as number | null,
  };
}

function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
