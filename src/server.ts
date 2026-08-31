/**
 * Minimal HTTP surface for SCANETH.
 *
 * Railway needs a healthcheck target, and `/stats` exposes what the scanner is
 * currently seeing.
 */

import { createServer, type Server } from 'node:http';
import { createLogger, errMeta } from './logger';
import type { BotState } from './state';
import type { ScanethConfig } from './config';
import type { TokenLaunch } from './scaneth/types';

const log = createLogger('server');

export interface ServerDeps {
  config: ScanethConfig;
  state: BotState;
  recentAlerts: () => TokenLaunch[];
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          status: 'ok',
          scannerEnabled: deps.config.enabled,
          uptimeSeconds: Math.floor((Date.now() - deps.state.startedAt) / 1000),
          blocksProcessed: deps.state.blocksProcessed,
          lastBlockNumber: deps.state.lastBlockNumber,
        }),
      );
      return;
    }

    if (url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        json({
          config: {
            rpcUrl: deps.config.rpcUrl.replace(/\/\/.*@/, '//***@'),
            maxAgeHours: deps.config.maxAgeHours,
            minH1Txns: deps.config.minH1Txns,
            minH1Sells: deps.config.minH1Sells,
            alertRiskScore: deps.config.alertRiskScore,
            maxSafetyScore: deps.config.maxSafetyScore,
            probeEth: deps.config.probeEth,
            maxTaxBps: deps.config.maxTaxBps,
            maxTopHolderPct: deps.config.maxTopHolderPct,
            pollIntervalMs: deps.config.pollIntervalMs,
            athPollIntervalMs: deps.config.athPollIntervalMs,
            athTrackerEnabled: deps.config.athTrackerEnabled,
          },
          state: deps.state.snapshot(),
        }),
      );
      return;
    }

    if (url === '/alerts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json(deps.recentAlerts().slice(0, 20)));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(json({ error: 'not found', routes: ['/health', '/stats', '/alerts'] }));
  });

  server.on('error', (err) => log.error('http server error', errMeta(err)));

  server.listen(deps.config.port, () => {
    log.info('http server listening', {
      port: deps.config.port,
      routes: ['/health', '/stats', '/alerts'],
    });
  });

  return server;
}
