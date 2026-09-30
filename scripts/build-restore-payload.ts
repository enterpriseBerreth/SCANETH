/**
 * Build the one-time paper-state restore payload from the pre-deploy snapshot
 * (positions + stats captured before state persistence shipped). Fetches each
 * token's decimals on-chain to reconstruct bigint balances.
 * Usage: npx tsx scripts/build-restore-payload.ts
 */
import { JsonRpcProvider, Contract } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = 'https://ethereum-rpc.publicnode.com';
const WALLETS = {
  b51ff2: '0xb51ff2f65b935142aab32abefa1c0e29a4161d31',
  c05ef5: '0xc05ef5e1fd014267f66fa24b260f361af7d79122',
};
const CONTRIBUTORS: Record<string, string[]> = {
  '0x27b39f47659b90ffb5e082ee5b704a697d36dea6': [WALLETS.b51ff2], // hello world
  '0x664e9d73db2a3514f6b437137de4779977a06e81': [WALLETS.b51ff2], // MOMO
  '0x5886e4d8d6a41a5ea2f3f77f23d7a7e942d581f1': [], // KLIK (scout-cut wallet)
  '0xea36af87df952fd4c9a05cd792d370909bbda8db': [WALLETS.c05ef5], // KPOP
  '0xf7f25f65d0146428f604700df75741556030d539': [], // IMDT (scout-cut wallet)
  '0x24c2c6f74f7d34664d85b98bdde5b6048420476c': [WALLETS.b51ff2], // Oyster Coin
};

async function main(): Promise<void> {
  const snap = JSON.parse(readFileSync('data/positions-snapshot.json', 'utf8'));
  const stats = JSON.parse(readFileSync('data/stats-snapshot.json', 'utf8'));
  const provider = new JsonRpcProvider(RPC);
  const abi = ['function decimals() view returns (uint8)'];

  const positions = [];
  for (const p of snap.positions as Array<{
    token: string;
    symbol: string;
    name: string;
    units: number;
    costBasisUsd: number;
    avgEntryUsd: number;
    currentPriceUsd: number;
    pnlUsd: number;
    openedAt: number;
  }>) {
    let decimals = 18;
    try {
      const c = new Contract(p.token, abi, provider);
      decimals = Number(await c['decimals']!());
    } catch (err) {
      console.warn('decimals() failed, using 18:', p.symbol, String(err).slice(0, 80));
    }
    const balance = BigInt(Math.floor(p.units * Math.pow(10, decimals)));
    const qty = Number(balance) / Math.pow(10, decimals);
    positions.push({
      tokenAddress: p.token,
      name: p.name,
      symbol: p.symbol,
      decimals,
      balance: balance.toString(),
      costBasisUsd: p.costBasisUsd,
      avgEntryPriceUsd: qty > 0 ? p.costBasisUsd / qty : p.avgEntryUsd,
      realizedPnlUsd: 0,
      currentPriceUsd: p.currentPriceUsd,
      openedAt: p.openedAt,
      updatedAt: p.openedAt,
      contributors: CONTRIBUTORS[p.token] ?? [],
    });
    console.log(
      p.symbol.padEnd(12),
      'dec', String(decimals).padEnd(3),
      'qty', qty.toPrecision(8).padEnd(14),
      'entry', p.avgEntryUsd.toPrecision(5),
      'mark', p.currentPriceUsd,
    );
    await new Promise((r) => setTimeout(r, 300));
  }

  const payload = {
    version: 1,
    savedAt: Date.now(),
    cashUsd: stats.copytrader.cashUsd,
    cumulativeRealizedUsd: stats.copytrader.totalRealizedPnlUsd,
    tradeCount: stats.copytrader.tradeCount,
    premiumWallets: [WALLETS.b51ff2, WALLETS.c05ef5],
    positions,
  };
  writeFileSync('data/restore-payload.json', JSON.stringify(payload, null, 2));
  console.log('\nwrote data/restore-payload.json with', positions.length, 'positions');
}

void main();
