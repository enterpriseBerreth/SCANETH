/**
 * Block-driven scan triggering.
 *
 * Arbitrage state is only valid for one block. A fixed-interval timer is
 * therefore the wrong clock: with a 6s interval and 2s blocks, a scan is on
 * average one and a half blocks stale before it starts, and every quote it
 * gathers describes a market that has already moved. Subscribing to new heads
 * instead means a scan begins as soon as the state it depends on changes.
 *
 * Two design points worth stating explicitly:
 *
 *  - **WebSocket is preferred but never required.** If no `wss://` endpoint is
 *    configured, or the socket drops and will not come back, the watcher falls
 *    back to polling `eth_blockNumber`. That is still block-aligned and still
 *    strictly better than a blind timer, so a missing WebSocket URL degrades
 *    latency rather than breaking the bot.
 *  - **Reconnection is assumed, not exceptional.** Hosted WebSocket endpoints
 *    drop connections routinely. A watcher that silently stopped firing after
 *    the first disconnect would look exactly like a quiet market, which is the
 *    failure mode this file exists to avoid.
 */
import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { createLogger, errMeta } from '../logger';

const log = createLogger('blocks');

/** Backoff bounds for WebSocket reconnection. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * How many consecutive WebSocket failures before giving up and polling.
 * Not infinite: if an endpoint is misconfigured, retrying forever would hide the
 * problem behind a bot that appears to run but never scans.
 */
const MAX_WS_ATTEMPTS = 5;

export interface BlockWatcherOptions {
  chainName: string;
  /** Optional wss:// endpoint. Falls back to polling when absent. */
  wsUrl?: string;
  /** Used for the polling fallback. */
  httpProvider: JsonRpcProvider;
  /** Poll cadence for the fallback path; should be near the chain's block time. */
  pollIntervalMs: number;
  /** Invoked once per observed block. Must not throw. */
  onBlock: (blockNumber: number) => void;
}

export class BlockWatcher {
  private ws?: WebSocketProvider;
  private pollTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private wsAttempts = 0;
  private lastBlock = 0;
  private stopped = false;
  private mode: 'block' | 'poll' = 'poll';

  constructor(private readonly opts: BlockWatcherOptions) {}

  /** Current trigger mode, for reporting in /stats. */
  get triggerMode(): 'block' | 'poll' {
    return this.mode;
  }

  start(): void {
    if (this.opts.wsUrl) {
      this.connectWs();
      return;
    }
    log.info('no websocket endpoint configured, polling block numbers instead', {
      chain: this.opts.chainName,
      pollIntervalMs: this.opts.pollIntervalMs,
    });
    this.startPolling();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
    void this.teardownWs();
  }

  private async teardownWs(): Promise<void> {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try {
      await ws.removeAllListeners();
      await ws.destroy();
    } catch {
      // Destroying an already-dead socket is not worth reporting.
    }
  }

  private connectWs(): void {
    if (this.stopped) return;
    const url = this.opts.wsUrl;
    if (!url) return;

    try {
      const ws = new WebSocketProvider(url);
      this.ws = ws;

      ws.on('block', (blockNumber: number) => {
        this.wsAttempts = 0;
        this.mode = 'block';
        // Stop the fallback poller once real events arrive, so a recovered
        // socket does not leave two triggers running in parallel.
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = undefined;
        }
        this.emit(blockNumber);
      });

      ws.on('error', (err: unknown) => {
        log.warn('websocket error', { chain: this.opts.chainName, ...errMeta(err) });
        this.scheduleReconnect();
      });

      // ethers does not surface socket closure as an event on the provider, so
      // the underlying socket is watched directly.
      const socket = (ws as unknown as { websocket?: { onclose?: unknown } }).websocket;
      if (socket) {
        socket.onclose = () => {
          if (this.stopped) return;
          log.warn('websocket closed', { chain: this.opts.chainName });
          this.scheduleReconnect();
        };
      }

      log.info('subscribed to new blocks over websocket', { chain: this.opts.chainName });
    } catch (err) {
      log.warn('websocket connect failed', { chain: this.opts.chainName, ...errMeta(err) });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.wsAttempts += 1;
    void this.teardownWs();

    // Poll in the meantime so scanning never actually stops while the socket is
    // down — a gap here would be indistinguishable from an idle market.
    if (!this.pollTimer) {
      this.mode = 'poll';
      this.startPolling();
    }

    if (this.wsAttempts > MAX_WS_ATTEMPTS) {
      log.warn('giving up on websocket, staying on block polling', {
        chain: this.opts.chainName,
        attempts: this.wsAttempts,
      });
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.wsAttempts - 1), RECONNECT_MAX_MS);
    log.info('reconnecting websocket', {
      chain: this.opts.chainName,
      attempt: this.wsAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectWs();
    }, delay);
  }

  private startPolling(): void {
    if (this.stopped || this.pollTimer) return;

    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const blockNumber = await this.opts.httpProvider.getBlockNumber();
        this.emit(blockNumber);
      } catch (err) {
        log.debug('block poll failed', { chain: this.opts.chainName, ...errMeta(err) });
      }
      if (this.stopped) return;
      this.pollTimer = setTimeout(() => void tick(), this.opts.pollIntervalMs);
    };

    this.pollTimer = setTimeout(() => void tick(), 0);
  }

  /** Deduplicate: WebSocket and the fallback poller can both observe a block. */
  private emit(blockNumber: number): void {
    if (!Number.isFinite(blockNumber) || blockNumber <= this.lastBlock) return;
    this.lastBlock = blockNumber;
    try {
      this.opts.onBlock(blockNumber);
    } catch (err) {
      log.error('block handler threw', { chain: this.opts.chainName, ...errMeta(err) });
    }
  }
}
