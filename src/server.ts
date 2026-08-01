/**
 * Minimal HTTP surface.
 *
 * Railway needs a healthcheck target, and a long-running bot that cannot be
 * inspected is a bot you cannot trust. `/stats` exposes the full run state so
 * you can see what it is actually doing without shelling into the container.
 */

import { createServer, type Server } from 'node:http';
import { createLogger, errMeta } from './logger';
import type { BotState } from './state';
import type { ArboConfig } from './config';

const log = createLogger('server');

export interface ServerDeps {
  config: ArboConfig;
  state: BotState;
  /** Extra per-chain detail, supplied by the orchestrator. */
  describeChains: () => Record<string, unknown>;
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
}

export function startServer(deps: ServerDeps): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/health' || url === '/') {
      // Deliberately shallow: liveness only. A scan failure should not cause
      // Railway to restart the container mid-trade.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          status: 'ok',
          mode: deps.config.mode,
          uptimeSeconds: Math.floor((Date.now() - deps.state.startedAt) / 1000),
          scansCompleted: deps.state.scansCompleted,
        }),
      );
      return;
    }

    if (url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          mode: deps.config.mode,
          chains: deps.config.chains,
          thresholds: {
            minProfitUsd: deps.config.minProfitUsd,
            minTradeUsd: deps.config.minTradeUsd,
            maxTradeUsd: deps.config.maxTradeUsd,
            maxDailyLossUsd: deps.config.maxDailyLossUsd,
          },
          state: deps.state.snapshot(),
          onchain: deps.describeChains(),
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(json({ error: 'not found', routes: ['/health', '/stats'] }));
  });

  server.on('error', (err) => log.error('http server error', errMeta(err)));

  server.listen(deps.config.port, () => {
    log.info('http server listening', {
      port: deps.config.port,
      routes: ['/health', '/stats'],
    });
  });

  return server;
}
