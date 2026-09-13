/**
 * SCANETH Ethereum provider setup.
 */

import { JsonRpcProvider, WebSocketProvider, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';

const log = createLogger('scaneth:provider');

export interface ProviderPair {
  /** Primary provider used for block subscriptions. */
  main: Provider;
  /** Separate HTTP provider used for heavy batch calls. */
  http: JsonRpcProvider;
}

/**
 * Build providers from environment. SCANETH prefers a WebSocket URL for
 * real-time block streaming and falls back to HTTP polling.
 *
 * JSON-RPC batching is capped at 3 requests: dRPC (and other free tiers)
 * reject batches larger than 3, which silently killed parallel probes.
 */
export function createProviders(rpcUrl: string, wsUrl?: string): ProviderPair {
  const http = new JsonRpcProvider(rpcUrl, undefined, {
    staticNetwork: true,
    batchMaxCount: 3,
    batchStallTime: 50,
  });

  let main: Provider;
  if (wsUrl) {
    try {
      main = new WebSocketProvider(wsUrl);
      log.info('using websocket provider');
    } catch (err) {
      log.warn('websocket provider failed, falling back to http polling', errMeta(err));
      main = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 3 });
    }
  } else {
    log.info('no websocket url, using http polling provider');
    main = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 3 });
  }

  return { main, http };
}

/** Destroy both providers cleanly. */
export function destroyProviders(pair: ProviderPair): void {
  try {
    pair.http.destroy();
  } catch {
    // ignore
  }
  try {
    if ('destroy' in pair.main && typeof pair.main.destroy === 'function') {
      pair.main.destroy();
    }
  } catch {
    // ignore
  }
}
