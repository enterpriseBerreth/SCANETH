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
import type { CopyTrader, CopyTraderStats } from './scaneth/copytrader';
import type { ScoutStats } from './scaneth/wallet-scout';

const log = createLogger('server');

export interface ServerDeps {
  config: ScanethConfig;
  state: BotState;
  recentAlerts: () => TokenLaunch[];
  copytrader?: CopyTrader;
  copytraderStats?: () => CopyTraderStats | undefined;
  scoutStats?: () => ScoutStats | undefined;
  positions?: () => ReturnType<NonNullable<CopyTrader['getOpenPositions']>>;
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
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const url = parsed.pathname;
    void handle(req, res, parsed, url);
  });

  server.on('error', (err) => log.error('http server error', errMeta(err)));

  server.listen(deps.config.port, () => {
    log.info('http server listening', {
      port: deps.config.port,
      routes: ['/health', '/stats', '/positions', '/alerts', '/dump', '/restore', '/exit', '/reset'],
    });
  });

  return server;

  async function handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    parsed: URL,
    url: string,
  ): Promise<void> {
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
            probeEth: deps.config.probeEth,
            maxTaxBps: deps.config.maxTaxBps,
            maxTopHolderPct: deps.config.maxTopHolderPct,
            pollIntervalMs: deps.config.pollIntervalMs,
            athPollIntervalMs: deps.config.athPollIntervalMs,
            athTrackerEnabled: deps.config.athTrackerEnabled,
            dailyReportEnabled: deps.config.dailyReportEnabled,
            dailyReportHourUtc: deps.config.dailyReportHourUtc,
            copytraderEnabled: deps.config.copytraderEnabled,
            copytraderWatchedWallets: deps.config.copytraderWatchedWallets,
            copytraderBuyAmountUsd: deps.config.copytraderBuyAmountUsd,
          },
          state: deps.state.snapshot(),
          copytrader: deps.copytraderStats?.(),
          scout: deps.scoutStats?.(),
        }),
      );
      return;
    }

    if (url === '/positions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ positions: deps.positions?.() ?? [] }));
      return;
    }

    if (url === '/alerts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json(deps.recentAlerts().slice(0, 20)));
      return;
    }

    // --- Admin endpoints (require COPYTRADER_ADMIN_KEY) ---

    if (['/dump', '/restore', '/exit', '/reset'].includes(url)) {
      const key = parsed.searchParams.get('key') ?? '';
      if (!deps.config.copytraderAdminKey || key !== deps.config.copytraderAdminKey) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(json({ error: 'forbidden' }));
        return;
      }
      const trader = deps.copytrader;
      if (!trader) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(json({ error: 'copytrader not enabled' }));
        return;
      }

      if (url === '/dump') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(json(trader.serializeState()));
        return;
      }

      if (url === '/restore') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(json({ error: 'POST required' }));
          return;
        }
        try {
          const body = await readBody(req);
          const state = JSON.parse(body);
          await trader.restoreState(state);
          log.warn('paper state restored via admin endpoint', {
            positions: trader.getOpenPositions().length,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json({ ok: true, positions: trader.getOpenPositions().length }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(json({ error: err instanceof Error ? err.message : 'invalid payload' }));
        }
        return;
      }

      if (url === '/exit') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(json({ error: 'POST required' }));
          return;
        }
        const token = parsed.searchParams.get('token') ?? '';
        if (!token.startsWith('0x') || token.length !== 42) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(json({ error: 'token query param must be a 42-char address' }));
          return;
        }
        const exited = await trader.exitToken(token, 'manual-api');
        res.writeHead(exited ? 200 : 404, { 'content-type': 'application/json' });
        res.end(json({ ok: exited, exited }));
        return;
      }

      // /reset
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(json({ error: 'POST required' }));
        return;
      }
      await trader.resetPaperAccount();
      log.warn('paper account reset via admin endpoint');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(json({ ok: true, reset: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(json({ error: 'not found', routes: ['/health', '/stats', '/positions', '/alerts'] }));
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
