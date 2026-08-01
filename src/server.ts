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
import type { PaperStats, PaperTrade } from './paper';

const log = createLogger('server');

export interface ServerDeps {
  config: ArboConfig;
  state: BotState;
  /** Extra per-chain detail, supplied by the orchestrator. */
  describeChains: () => Record<string, unknown>;
  paperStats: () => PaperStats;
  paperTrades: () => PaperTrade[];
  /** False when ledger writes have failed and history is memory-only. */
  paperDurable: () => boolean;
  paperLedgerPath: () => string;
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
            minPoolLiquidityUsd: deps.config.minPoolLiquidityUsd,
          },
          state: deps.state.snapshot(),
          paper: deps.paperStats(),
          onchain: deps.describeChains(),
        }),
      );
      return;
    }

    if (url === '/paper') {
      const stats = deps.paperStats();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          mode: deps.config.mode,
          // Stated inline so the numbers are never read without their caveats.
          methodology:
            'Every candidate is re-quoted on-chain after PAPER_SETTLE_DELAY_MS and ' +
            'booked at that second price, net of gas. Detected profit is treated as a ' +
            'prediction only. Competition and inclusion risk are NOT modelled, so real ' +
            'fill rates would be lower than reported, never higher.',
          settleDelayMs: deps.config.paperSettleDelayMs,
          minProfitUsd: deps.config.minProfitUsd,
          durable: deps.paperDurable(),
          ledgerPath: deps.paperLedgerPath(),
          stats,
          recentTrades: deps.paperTrades(),
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(json({ error: 'not found', routes: ['/health', '/stats', '/paper'] }));
  });

  server.on('error', (err) => log.error('http server error', errMeta(err)));

  server.listen(deps.config.port, () => {
    log.info('http server listening', {
      port: deps.config.port,
      routes: ['/health', '/stats', '/paper'],
    });
  });

  return server;
}
