import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlert } from '../src/scaneth/analyzer';
import type { TokenLaunch } from '../src/scaneth/types';

const baseLaunch = {
  id: 'token-1',
  blockNumber: 1,
  discoveredAt: Date.now(),
  tokenAddress: '0x0000000000000000000000000000000000000001',
  metadata: {
    name: 'Test Token',
    symbol: 'TT',
    decimals: 18,
    totalSupply: 1_000_000n,
    complete: true,
  },
  risk: {
    score: 10,
    tier: 'low',
    findings: [],
  },
  dexScreener: {
    pair: {
      pairAddress: '0x0000000000000000000000000000000000000002',
      tokenAddress: '0x0000000000000000000000000000000000000001',
      priceUsd: '1',
      marketCap: 1000,
      liquidity: { usd: 5000 },
      txns: {
        h1: { buys: 10, sells: 1 },
      },
    } as any,
    ageMs: 60_000,
    h1Txns: 11,
    h1Buys: 10,
    h1Sells: 1,
    totalTxns: 11,
  },
} satisfies TokenLaunch;

test('shouldAlert blocks launches with critical safety issues', () => {
  const launch: TokenLaunch = {
    ...baseLaunch,
    risk: {
      ...baseLaunch.risk,
      safety: {
        okay: false,
        criticalIssues: ['honeypot'],
        warnings: [],
        honeypot: true,
        buyTaxPct: 40,
        maxTxBlocksSell: false,
        lpBurned: false,
        ownerRenounced: false,
        holderConcentrationPct: 80,
        adminFlags: [],
      },
    },
  };

  assert.equal(
    shouldAlert(launch, { maxAgeHours: 6, minH1Txns: 10, minH1Sells: 1, maxRiskScore: 100 }),
    false,
  );
});

test('shouldAlert allows launches without critical safety issues', () => {
  const launch: TokenLaunch = {
    ...baseLaunch,
    risk: {
      ...baseLaunch.risk,
      safety: {
        okay: true,
        criticalIssues: [],
        warnings: [],
        honeypot: false,
        buyTaxPct: 5,
        maxTxBlocksSell: false,
        lpBurned: true,
        ownerRenounced: true,
        holderConcentrationPct: 35,
        adminFlags: [],
      },
    },
  };

  assert.equal(
    shouldAlert(launch, { maxAgeHours: 6, minH1Txns: 10, minH1Sells: 1, maxRiskScore: 100 }),
    true,
  );
});
