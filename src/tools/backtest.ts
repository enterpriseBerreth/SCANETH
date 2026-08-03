/**
 * Historical backtest.
 *
 * Replays the *real* scanner against *real* past chain state. Every quote below
 * is answered by an archive node at a specific historical block — no simulated
 * order books, no synthetic price series, no reconstructed reserves. The same
 * adapters, the same profit engine, the same gas accounting the live bot uses,
 * pointed at yesterday.
 *
 * This is possible because `ChainContext.blockTag` pins every batched read, and
 * every quote in the codebase funnels through `multicall`. There is no second
 * "backtest pricing model" that could drift from production, which is the usual
 * way backtests end up lying.
 *
 * ── What this measures, and what it does not ────────────────────────────────
 *
 * It measures: **did a profitable edge exist at that block, after real fees,
 * real price impact at real trade size, and the real gas price of that block?**
 *
 * It does not measure whether ARBO would have *won* that edge. Capturing an
 * on-chain arb means landing a transaction in the very next block, competing
 * against searchers with co-located infrastructure and private orderflow. A
 * positive result here is a necessary condition for profitability, not a
 * sufficient one — it says the opportunity was real, not that it was winnable.
 *
 * Read the output accordingly: zero profitable blocks is a hard, reliable *no*.
 * A positive count is a "worth continuing to measure", not a forecast.
 *
 * Usage:
 *   npx tsx src/tools/backtest.ts --chain optimism --samples 40 --spacing 300
 */
import { Contract, JsonRpcProvider, Network } from 'ethers';
import { loadConfig } from '../config';
import { getChain } from '../chains';
import { createChainContext, type ChainContext } from '../onchain/provider';
import { MULTICALL3_ABI } from '../onchain/abi';
import {
  discoverPools,
  refreshPools,
  filterV3ByDepth,
  v2LiquidityUsd,
  solidlyLiquidityUsd,
  liquidityFloorFor,
  type PoolSet,
} from '../onchain/dex';
import { PriceOracle } from '../onchain/prices';
import { scanChainVerbose } from '../onchain/scanner';
import { validateChain } from '../onchain/validate';
import type { ChainName, ArbOpportunity, TokenInfo } from '../types';

interface Args {
  chain: ChainName;
  samples: number;
  spacing: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    chain: (get('--chain') ?? 'base') as ChainName,
    samples: Number(get('--samples') ?? 30),
    // Blocks between samples. Spacing them out beats scanning a contiguous run:
    // adjacent blocks are highly correlated, so 30 consecutive blocks tell you
    // about one market moment, while 30 spread over hours sample many.
    spacing: Number(get('--spacing') ?? 200),
  };
}

interface SampleResult {
  block: number;
  timestamp: number;
  gasGwei: number;
  bestEdgeBps: number | null;
  bestEdgeRoute: string | null;
  opportunities: ArbOpportunity[];
  /** Real cycles that priced positive gross but did not clear the profit floor. */
  nearMisses: ArbOpportunity[];
  edgeByRoute: Map<string, number>;
  pairsComparable: number;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config = loadConfig();
  const chain = getChain(args.chain);

  const ctx = createChainContext(config, chain);
  const network = Network.from(chain.chainId);

  // The main RPC is not assumed to serve archive state. Candidates are probed
  // and the first that answers a historical `eth_call` is used; without this the
  // backtest silently degrades into "every quote reverted, no edges found",
  // which looks exactly like a real negative result.
  const archive = await pickArchiveProvider(config.logsRpcUrls[args.chain], network);
  if (!archive) {
    console.error(`no archive-capable endpoint found for ${args.chain}; cannot backtest`);
    process.exit(1);
  }
  console.log(`archive endpoint: ${archive.url}`);

  const validation = await validateChain(ctx);
  const head = await archive.provider.getBlockNumber();

  const archiveCtx: ChainContext = {
    ...ctx,
    provider: archive.provider,
    multicall: new Contract(chain.multicall3, MULTICALL3_ABI, archive.provider),
  };

  // Pools are discovered at head. A pool that did not exist at the sampled block
  // simply reverts and drops out, which is correct — it could not have traded.
  const discovered = await discoverPools(archiveCtx, new Set(validation.enabledVenueIds));

  // V3 depth is filtered once at head, exactly as the live bot does at startup.
  // V2 and Solidly depth is re-checked per sample from that block's reserves.
  const seed = await refreshPools(archiveCtx, discovered);
  const seedOracle = new PriceOracle(chain);
  seedOracle.refresh(seed);
  const { kept } = await filterV3ByDepth(archiveCtx, seed.v3, config.minPoolLiquidityUsd, (t) =>
    seedOracle.usd(t),
  );
  discovered.v3 = kept;

  // Historical blocks carry a base fee but no record of what tip the bot would
  // have offered. Today's suggested priority fee is the honest stand-in; on
  // these L2s it is a rounding error next to the base fee either way.
  const feeData = await archive.provider.getFeeData();
  const priorityFeeWei = feeData.maxPriorityFeePerGas ?? 0n;

  console.log(
    `chain=${args.chain} head=${head} pools: v2=${discovered.v2.length} ` +
      `v3=${discovered.v3.length} solidly=${discovered.solidly.length} curve=${discovered.curve.length}`,
  );

  const oldest = head - args.samples * args.spacing;
  console.log(
    `sampling ${args.samples} blocks, every ${args.spacing} blocks, back to ${oldest}\n`,
  );

  const results: SampleResult[] = [];

  for (let i = 0; i < args.samples; i += 1) {
    const block = head - i * args.spacing;
    const sample = await runSample(archiveCtx, config, discovered, block, priorityFeeWei);
    results.push(sample);

    const edge = sample.bestEdgeBps === null ? '   n/a' : sample.bestEdgeBps.toFixed(2).padStart(7);
    const hits = sample.opportunities.length;
    const flag = hits > 0 ? ` <<< ${hits} PROFITABLE` : '';
    const when = new Date(sample.timestamp * 1000).toISOString().slice(5, 16).replace('T', ' ');
    console.log(
      `${String(block).padStart(10)} ${when}  gas=${sample.gasGwei.toFixed(4).padStart(8)}gwei  ` +
        `pairs=${String(sample.pairsComparable).padStart(2)}  bestEdge=${edge}bps${flag}` +
        (sample.error ? `  ERR ${sample.error}` : ''),
    );
  }

  report(args, results, config.minProfitUsd);
}

async function pickArchiveProvider(
  urls: string[],
  network: Network,
): Promise<{ url: string; provider: JsonRpcProvider } | undefined> {
  for (const url of urls) {
    try {
      const provider = new JsonRpcProvider(url, network, {
        staticNetwork: network,
        batchMaxCount: 12,
      });
      const head = await provider.getBlockNumber();
      // 50k blocks back is far enough that a pruned node will refuse.
      await provider.call({
        to: '0xcA11bde05977b3631167028862bE2a173976CA11',
        data: '0x0f28c97d',
        blockTag: head - 50_000,
      });
      return { url, provider };
    } catch {
      // Pruned or rate-limited; try the next candidate.
    }
  }
  return undefined;
}

async function runSample(
  ctx: ChainContext,
  config: ReturnType<typeof loadConfig>,
  discovered: PoolSet,
  block: number,
  priorityFeeWei: bigint,
): Promise<SampleResult> {
  const pinned: ChainContext = { ...ctx, blockTag: block };

  try {
    const header = await ctx.provider.getBlock(block);
    if (!header) throw new Error('block not found');

    // The real base fee of that block, not today's. Gas is the largest cost line
    // for a small arb, so using current gas would make a cheap past look
    // profitable or an expensive one look dead. The `base * 2 + tip` shape
    // mirrors how ethers derives `maxFeePerGas`, which is what the live bot
    // budgets against — a backtest that priced gas more cheaply than production
    // would be flattering itself.
    const baseFee = header.baseFeePerGas ?? 0n;
    const gasPriceWei = baseFee * 2n + priorityFeeWei;

    // Reserves and prices are re-read at the pinned block, so V2 and Solidly
    // local math runs on the state that actually existed then.
    const pools = await refreshPools(pinned, discovered);
    const oracle = new PriceOracle(pinned.chain);
    oracle.refresh(pools);

    if (oracle.nativeUsd() <= 0) throw new Error('no native price at this block');

    // The same depth floor the live scanner applies every pass. Skipping it does
    // not make the backtest more permissive, it makes it *wrong*: a dust pool
    // quotes an enormous phantom edge that live would never have seen, and the
    // report ends up describing a bot that does not exist.
    const priceOf = (t: TokenInfo): number => oracle.usd(t);
    const floors = {
      volatileUsd: config.minPoolLiquidityUsd,
      stableUsd: config.minStablePoolLiquidityUsd,
    };
    const scanPools: PoolSet = {
      v2: pools.v2.filter((p) => v2LiquidityUsd(p, priceOf) >= liquidityFloorFor(p, floors)),
      v3: pools.v3,
      solidly: pools.solidly.filter(
        (p) => solidlyLiquidityUsd(p, priceOf) >= liquidityFloorFor(p, floors),
      ),
      curve: pools.curve,
    };

    const { actionable, nearMisses, diagnostics } = await scanChainVerbose({
      ctx: pinned,
      pools: scanPools,
      oracle,
      config,
      gasPriceWei,
      // No dirty-pool reuse: each sample is an independent point in time, and
      // reusing a quote across samples would silently blend two blocks.
    });

    return {
      block,
      timestamp: header.timestamp,
      gasGwei: Number(gasPriceWei) / 1e9,
      bestEdgeBps: diagnostics.bestEdgeBps,
      bestEdgeRoute: diagnostics.bestEdgeRoute,
      opportunities: actionable,
      nearMisses,
      edgeByRoute: diagnostics.edgeByRoute,
      pairsComparable: diagnostics.pairsComparable,
    };
  } catch (err) {
    return {
      block,
      timestamp: 0,
      gasGwei: 0,
      bestEdgeBps: null,
      bestEdgeRoute: null,
      opportunities: [],
      nearMisses: [],
      edgeByRoute: new Map(),
      pairsComparable: 0,
      error: (err as Error).message.slice(0, 60),
    };
  }
}

/** `USDC: aerodrome -> uniswap-v3`, matching how routes read in the live logs. */
function routeLabel(o: ArbOpportunity): string {
  return `${o.baseToken.symbol}: ${o.legs.map((l) => l.venueId).join(' -> ')}`;
}

function report(args: Args, results: SampleResult[], minProfitUsd: number): void {
  const ok = results.filter((r) => !r.error);
  const edges = ok.map((r) => r.bestEdgeBps).filter((e): e is number => e !== null);
  const profitable = ok.filter((r) => r.opportunities.length > 0);

  const netUsd = profitable.flatMap((r) => r.opportunities).reduce((s, o) => s + o.netProfitUsd, 0);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`BACKTEST  chain=${args.chain}  samples=${ok.length}/${results.length} ok`);
  console.log('='.repeat(72));

  if (edges.length > 0) {
    const sorted = [...edges].sort((a, b) => a - b);
    const pct = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    console.log('best edge per block (bps, after fees and price impact):');
    console.log(
      `  worst ${(sorted[0] ?? 0).toFixed(2)}   p50 ${pct(0.5).toFixed(2)}   ` +
        `p90 ${pct(0.9).toFixed(2)}   best ${(sorted[sorted.length - 1] ?? 0).toFixed(2)}`,
    );
    console.log(
      `  blocks with a positive edge: ${edges.filter((e) => e > 0).length}/${edges.length}`,
    );
  }

  console.log(
    `\nblocks clearing the $${minProfitUsd} profit floor net of gas: ${profitable.length}/${ok.length}`,
  );
  if (profitable.length > 0) {
    console.log(`total net profit across samples: $${netUsd.toFixed(2)}`);
    for (const r of profitable.slice(0, 10)) {
      for (const o of r.opportunities) {
        console.log(`  block ${r.block}  ${routeLabel(o)}  net $${o.netProfitUsd.toFixed(2)}`);
      }
    }
  }

  // Near misses are the most informative line in the whole report. A cycle that
  // priced positive gross and then died on gas says the *market* offered an edge
  // and the cost model ate it — a different problem, with different fixes, from
  // no edge existing at all.
  const near = ok.flatMap((r) => r.nearMisses);
  const positiveGross = near.filter((o) => o.grossProfitUsd > 0);
  console.log(
    `\nnear misses: ${near.length} cycles priced, ${positiveGross.length} with positive gross`,
  );
  if (positiveGross.length > 0) {
    const best = [...positiveGross].sort((a, b) => b.netProfitUsd - a.netProfitUsd).slice(0, 8);
    console.log('  closest to profitable (gross -> net after gas):');
    for (const o of best) {
      console.log(
        `    ${routeLabel(o).padEnd(42)} $${o.grossProfitUsd.toFixed(4).padStart(9)} -> ` +
          `$${o.netProfitUsd.toFixed(4).padStart(9)}  (gas $${o.gasCostUsd.toFixed(4)})`,
      );
    }
  }

  // Every route that was priced, not just whichever one led the chain. This is
  // the table that decides what to keep: a pair whose *best* edge across hours
  // of history is still deeply negative is not a pair that needs more venues or
  // faster scanning — it is a pair to stop quoting.
  const byRoute = new Map<string, { seen: number; best: number; sum: number }>();
  for (const r of ok) {
    for (const [route, bps] of r.edgeByRoute) {
      const cur = byRoute.get(route) ?? { seen: 0, best: -Infinity, sum: 0 };
      cur.seen += 1;
      cur.sum += bps;
      cur.best = Math.max(cur.best, bps);
      byRoute.set(route, cur);
    }
  }

  if (byRoute.size > 0) {
    console.log(`\nper-route edge across ${ok.length} samples (bps, best / mean):`);
    const rows = [...byRoute.entries()].sort((a, b) => b[1].best - a[1].best);
    for (const [route, s] of rows) {
      const mean = s.sum / s.seen;
      const flag = s.best > 0 ? '  <<< POSITIVE' : '';
      console.log(
        `  ${s.best.toFixed(2).padStart(9)} / ${mean.toFixed(2).padStart(9)}  ` +
          `seen ${String(s.seen).padStart(3)}x  ${route}${flag}`,
      );
    }
    console.log(`\n  routes ever positive: ${rows.filter(([, s]) => s.best > 0).length}/${rows.length}`);
  }

  const errs = results.filter((r) => r.error);
  if (errs.length > 0) {
    console.log(`\n${errs.length} samples failed: ${errs[0]?.error}`);
  }
}

void main();
