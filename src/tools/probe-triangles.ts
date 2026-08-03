/**
 * Why are no triangular cycles being priced?
 *
 * The backtest reports only the best edge per route, so a stage that silently
 * drops every candidate is invisible in it. This runs one scan and prints the
 * enumeration counters plus the actual token graph, which distinguishes "the
 * triples are unprofitable" from "no triples exist" from "the triples exist but
 * one leg never prices".
 */
import { loadConfig } from '../config.js';
import { getChain } from '../chains.js';
import { createChainContext } from '../onchain/provider.js';
import { validateChain } from '../onchain/validate.js';
import { discoverPools } from '../onchain/dex/index.js';
import { scanChainVerbose } from '../onchain/scanner.js';
import { PriceOracle } from '../onchain/prices.js';

async function main(): Promise<void> {
  const chainName = (process.argv[2] ?? 'optimism') as 'optimism';
  const config = loadConfig();
  const chain = getChain(chainName);
  const ctx = createChainContext(config, chain);

  const validation = await validateChain(ctx);
  const pools = await discoverPools(ctx, validation.enabledVenueIds);

  console.log(
    `pools: v2=${pools.v2.length} v3=${pools.v3.length} ` +
      `solidly=${pools.solidly.length} curve=${pools.curve.length}`,
  );

  // Which tokens can actually be reached, and by how many locally-priced pools.
  // A triangle needs three distinct pools forming a closed loop, so any token
  // touched by fewer than two local pools can never sit in the middle of one.
  const local = [...pools.v2, ...pools.solidly, ...pools.curve];
  const degree = new Map<string, number>();
  for (const p of local) {
    for (const t of [p.tokenA, p.tokenB]) {
      degree.set(t.symbol, (degree.get(t.symbol) ?? 0) + 1);
    }
  }
  console.log('\nlocal-pool degree per token (v2 + solidly + curve):');
  for (const [sym, n] of [...degree.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${sym}`);
  }

  console.log('\ncurve pools:');
  for (const p of pools.curve) {
    console.log(`  ${p.tokenA.symbol}/${p.tokenB.symbol}  ${p.pool}`);
  }

  console.log('\nsolidly pools touching a stable:');
  for (const p of pools.solidly) {
    if (!p.tokenA.stable && !p.tokenB.stable) continue;
    console.log(
      `  ${p.tokenA.symbol}/${p.tokenB.symbol} stable=${p.stable} ${p.pool}`,
    );
  }

  const oracle = new PriceOracle(chain);
  oracle.refresh(pools);
  const gasPriceWei = (await ctx.provider.getFeeData()).gasPrice ?? 1_000_000n;
  const { diagnostics } = await scanChainVerbose({
    ctx,
    pools,
    oracle,
    config,
    gasPriceWei,
  });

  console.log('\nscan diagnostics:');
  for (const [k, v] of Object.entries(diagnostics)) {
    if (v instanceof Map) continue;
    console.log(`  ${k}: ${String(v)}`);
  }

  process.exit(0);
}

void main();
