/**
 * Dirty-pool tracking.
 *
 * A scan pass re-quotes every pool on the chain, every block. That is wasteful
 * in a way that directly costs money on free infrastructure: a Base block moves
 * a handful of the pools ARBO watches, but the scanner pays the full
 * `eth_call` bill for all of them and then spends the wall-clock time to do it.
 * The bill matters because public RPC endpoints rate-limit, and the wall-clock
 * time matters more — a scan that takes two blocks to finish is quoting a market
 * that has already moved.
 *
 * The fix is to watch the pools' own logs and re-quote only what actually
 * traded. Everything else keeps last block's number, which is still exactly
 * right, because a pool that emitted no events did not change.
 *
 * Three deliberate choices:
 *
 *  - **Filter by address, not by topic.** Every venue family spells its state
 *    change differently — Uniswap V2 emits `Sync(uint112,uint112)`, Aerodrome
 *    emits `Sync(uint256,uint256)`, V3 emits `Swap(...)`, Curve emits
 *    `TokenExchange` in two incompatible shapes plus separate liquidity events.
 *    Enumerating those hashes means a silent miss every time a venue is added
 *    with a signature nobody thought of, and a missed event means quoting stale
 *    state indefinitely. Matching on the pool address instead is *over*-
 *    inclusive: an LP transfer marks a pool dirty when it did not need to be.
 *    That costs one redundant quote. The opposite error costs a bad trade.
 *
 *  - **Fail open, always.** If the log stream is unhealthy — never connected,
 *    dropped, or behind — every pool reports dirty and the scanner behaves
 *    exactly as it did before this file existed. An optimisation that can make
 *    the bot blind is not an optimisation.
 *
 *  - **Hard staleness ceiling.** Even while healthy, a pool untouched for
 *    `maxCleanBlocks` is re-quoted anyway. This bounds the damage from any event
 *    that changes a quote without emitting a log the filter sees (a fee-tier
 *    change, a rebasing token, a hook), so the worst case is a bounded staleness
 *    window rather than a permanently wrong cached price.
 */
import { JsonRpcProvider, WebSocketProvider, type Log } from 'ethers';
import { createLogger, errMeta } from '../logger';

const log = createLogger('dirty');

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_WS_ATTEMPTS = 5;

/**
 * `eth_getLogs` accepts a bounded address list. Public endpoints differ on the
 * ceiling, so requests are chunked well under the most restrictive one seen.
 */
const ADDRESS_CHUNK = 100;

/**
 * How far back to sweep when the poller falls behind. Beyond this the gap is
 * treated as a health failure and everything is marked dirty, which is cheaper
 * and safer than paging through hundreds of blocks of history.
 */
const MAX_CATCHUP_BLOCKS = 50;

export interface PoolActivityOptions {
  chainName: string;
  /** Pool addresses to watch. Case-insensitive. */
  pools: string[];
  /** Optional wss:// endpoint. Without one, logs are polled over HTTP. */
  wsUrl?: string;
  /**
   * Ordered `eth_getLogs` endpoints. Tried in turn; the first that answers is
   * kept. Free providers routinely serve `eth_call` while refusing
   * `eth_getLogs`, so the main chain RPC cannot be assumed to work here.
   */
  logsRpcUrls: string[];
  /** Poll cadence for the HTTP fallback; should track the chain's block time. */
  pollIntervalMs: number;
  /** Re-quote a pool at least this often even if it looks untouched. */
  maxCleanBlocks: number;
}

export interface PoolActivityStats {
  healthy: boolean;
  source: 'logs' | 'poll' | 'off';
  /** Endpoint currently serving logs, once one has proven it will. */
  endpoint: string | null;
  watched: number;
  /** Pools whose last observed event is newer than their last quote. */
  dirty: number;
  /** Total dirty marks observed since start — a liveness signal. */
  events: number;
  lastEventBlock: number;
}

export class PoolActivityTracker {
  private ws?: WebSocketProvider;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private wsAttempts = 0;
  private stopped = false;

  private readonly watched: string[];
  private readonly watchedSet: Set<string>;

  /** pool -> block at which it was last observed to change. */
  private readonly changedAt = new Map<string, number>();
  /** pool -> block at which it was last re-quoted by the scanner. */
  private readonly quotedAt = new Map<string, number>();

  private healthyFlag = false;
  private source: 'logs' | 'poll' | 'off' = 'off';
  private cursor = 0;
  private events = 0;
  private lastEventBlock = 0;

  /** Index into `logsRpcUrls`; advanced when the current endpoint refuses. */
  private endpointIndex = 0;
  private readonly logProviders = new Map<string, JsonRpcProvider>();

  constructor(private readonly opts: PoolActivityOptions) {
    this.watched = opts.pools.map((p) => p.toLowerCase());
    this.watchedSet = new Set(this.watched);
  }

  get healthy(): boolean {
    return this.healthyFlag;
  }

  /**
   * Should this pool be re-quoted at `block`?
   *
   * Returns true whenever the answer is not provably no: unknown pool, unhealthy
   * stream, never quoted, quote older than the staleness ceiling, or a logged
   * event at or after the last quote.
   */
  needsRequote(pool: string, block: number): boolean {
    if (!this.healthyFlag) return true;

    const key = pool.toLowerCase();
    if (!this.watchedSet.has(key)) return true;

    const quoted = this.quotedAt.get(key);
    if (quoted === undefined) return true;
    if (block - quoted >= this.opts.maxCleanBlocks) return true;

    const changed = this.changedAt.get(key);
    if (changed === undefined) return false;

    // `>=` not `>`: a quote taken during block N cannot be trusted to include an
    // event from block N, because the read may have landed on either side of it.
    return changed >= quoted;
  }

  /**
   * Record that `pool` was quoted at `block`.
   *
   * The caller must pass the block the scan *started* from, not the block that
   * is current when the quote returns. Stamping the later block would swallow
   * any event that arrived mid-scan and leave the stale quote looking fresh.
   */
  noteQuoted(pool: string, block: number): void {
    if (block <= 0) return;
    this.quotedAt.set(pool.toLowerCase(), block);
  }

  stats(): PoolActivityStats {
    let dirty = 0;
    for (const pool of this.watched) {
      const quoted = this.quotedAt.get(pool);
      if (quoted === undefined) {
        dirty += 1;
        continue;
      }
      const changed = this.changedAt.get(pool);
      if (changed !== undefined && changed >= quoted) dirty += 1;
    }

    return {
      healthy: this.healthyFlag,
      source: this.source,
      endpoint: this.healthyFlag ? (this.currentEndpoint() ?? null) : null,
      watched: this.watched.length,
      dirty,
      events: this.events,
      lastEventBlock: this.lastEventBlock,
    };
  }

  start(): void {
    if (this.watched.length === 0) {
      log.info('no pools to watch, dirty tracking disabled', { chain: this.opts.chainName });
      return;
    }

    if (this.opts.wsUrl) {
      this.connectWs();
      return;
    }

    log.info('no websocket endpoint, polling pool logs over http', {
      chain: this.opts.chainName,
      pools: this.watched.length,
    });
    this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    this.healthyFlag = false;
    this.source = 'off';
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
    void this.teardownWs();
  }

  // ── log ingestion ─────────────────────────────────────────────────────────

  private mark(address: string, blockNumber: number): void {
    const key = address.toLowerCase();
    if (!this.watchedSet.has(key)) return;
    if (!Number.isFinite(blockNumber) || blockNumber <= 0) return;

    const previous = this.changedAt.get(key) ?? 0;
    if (blockNumber <= previous) return;

    this.changedAt.set(key, blockNumber);
    this.events += 1;
    if (blockNumber > this.lastEventBlock) this.lastEventBlock = blockNumber;
  }

  private async teardownWs(): Promise<void> {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try {
      await ws.removeAllListeners();
      await ws.destroy();
    } catch {
      // Tearing down an already-dead socket is not worth reporting.
    }
  }

  private connectWs(): void {
    if (this.stopped) return;
    const url = this.opts.wsUrl;
    if (!url) return;

    try {
      const ws = new WebSocketProvider(url);
      this.ws = ws;

      // One subscription for the whole address set. Providers that reject an
      // address array fall through to the error handler and the HTTP poller.
      void ws
        .on({ address: this.watched }, (entry: Log) => {
          this.wsAttempts = 0;
          if (!this.healthyFlag) {
            this.healthyFlag = true;
            this.source = 'logs';
            log.info('pool log subscription live', {
              chain: this.opts.chainName,
              pools: this.watched.length,
            });
          }
          this.mark(entry.address, entry.blockNumber);
        })
        .catch((err: unknown) => {
          log.warn('pool log subscription failed', {
            chain: this.opts.chainName,
            ...errMeta(err),
          });
          this.scheduleReconnect();
        });

      ws.on('error', (err: unknown) => {
        log.warn('pool log websocket error', { chain: this.opts.chainName, ...errMeta(err) });
        this.scheduleReconnect();
      });

      const socket = (ws as unknown as { websocket?: { onclose?: unknown } }).websocket;
      if (socket) {
        socket.onclose = () => {
          if (this.stopped) return;
          log.warn('pool log websocket closed', { chain: this.opts.chainName });
          this.scheduleReconnect();
        };
      }
    } catch (err) {
      log.warn('pool log websocket connect failed', {
        chain: this.opts.chainName,
        ...errMeta(err),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.wsAttempts += 1;
    // Until a stream is confirmed live again the scanner must assume every pool
    // is stale, so nothing is served from a cache that stopped being maintained.
    this.healthyFlag = false;
    void this.teardownWs();

    if (!this.pollTimer) this.startPolling();

    if (this.wsAttempts > MAX_WS_ATTEMPTS) {
      log.warn('giving up on log websocket, staying on http log polling', {
        chain: this.opts.chainName,
        attempts: this.wsAttempts,
      });
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.wsAttempts - 1), RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWs();
    }, delay);
  }

  private startPolling(): void {
    if (this.stopped || this.pollTimer) return;

    if (this.opts.logsRpcUrls.length === 0) {
      log.warn('no log endpoint available, dirty tracking disabled', {
        chain: this.opts.chainName,
      });
      return;
    }

    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.healthyFlag = false;
        this.rotateEndpoint(err);
      }
      if (this.stopped) return;
      this.pollTimer = setTimeout(() => void tick(), this.opts.pollIntervalMs);
    };

    this.pollTimer = setTimeout(() => void tick(), 0);
  }

  private currentEndpoint(): string | undefined {
    return this.opts.logsRpcUrls[this.endpointIndex];
  }

  private logProvider(): JsonRpcProvider | undefined {
    const url = this.currentEndpoint();
    if (!url) return undefined;

    let provider = this.logProviders.get(url);
    if (!provider) {
      // `staticNetwork` skips the chainId handshake on every reconnect, which
      // matters because these are throwaway endpoints used for one method.
      provider = new JsonRpcProvider(url, undefined, { staticNetwork: true });
      this.logProviders.set(url, provider);
    }
    return provider;
  }

  /**
   * Move to the next log endpoint after a failure.
   *
   * A rationed provider fails identically every time, so retrying it is pure
   * latency. Once the list is exhausted the tracker wraps around and keeps
   * trying — endpoints rate-limit temporarily as often as they refuse outright,
   * and staying unhealthy in the meantime is already the safe behaviour.
   */
  private rotateEndpoint(err: unknown): void {
    const failed = this.currentEndpoint();
    const total = this.opts.logsRpcUrls.length;
    if (total === 0) return;

    this.endpointIndex = (this.endpointIndex + 1) % total;
    // The cursor belongs to the old endpoint's view of the chain; a fresh
    // endpoint re-establishes its own baseline rather than inheriting a gap.
    this.cursor = 0;

    log.debug('log endpoint refused, rotating', {
      chain: this.opts.chainName,
      failed,
      next: this.currentEndpoint(),
      ...errMeta(err),
    });
  }

  private async pollOnce(): Promise<void> {
    const provider = this.logProvider();
    if (!provider) return;

    const head = await provider.getBlockNumber();
    if (!Number.isFinite(head) || head <= 0) return;

    if (this.cursor === 0) {
      // First pass establishes a baseline only. Nothing is known about history,
      // so the tracker stays unhealthy for one interval rather than claiming a
      // clean slate it never verified.
      this.cursor = head;
      return;
    }

    if (head <= this.cursor) {
      // No new blocks. If the socket handed over cleanly this is still healthy.
      if (this.source !== 'logs') this.markPollHealthy();
      return;
    }

    if (head - this.cursor > MAX_CATCHUP_BLOCKS) {
      log.warn('pool log poller fell too far behind, resetting', {
        chain: this.opts.chainName,
        behind: head - this.cursor,
      });
      this.cursor = head;
      this.healthyFlag = false;
      return;
    }

    const fromBlock = this.cursor + 1;
    for (let i = 0; i < this.watched.length; i += ADDRESS_CHUNK) {
      const addresses = this.watched.slice(i, i + ADDRESS_CHUNK);
      const logs = await provider.getLogs({ address: addresses, fromBlock, toBlock: head });
      for (const entry of logs) this.mark(entry.address, entry.blockNumber);
    }

    this.cursor = head;
    this.markPollHealthy();
  }

  private markPollHealthy(): void {
    if (this.healthyFlag && this.source === 'poll') return;
    this.healthyFlag = true;
    this.source = 'poll';
    log.info('pool log polling live', {
      chain: this.opts.chainName,
      pools: this.watched.length,
      endpoint: this.currentEndpoint(),
    });
  }
}
