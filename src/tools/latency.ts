/**
 * What does latency actually cost us?
 *
 * A paid RPC is worth buying only if two things are true at once: our current
 * endpoint is measurably slow, *and* the edge moves fast enough that arriving
 * earlier would have caught a better price. Either one alone proves nothing. A
 * slow endpoint on a frozen market costs zero, and an instant endpoint on a
 * frozen market earns zero.
 *
 * So this measures both, and then prices the upgrade:
 *
 *   1. Round-trip latency of the batched quote a scan actually issues, as
 *      percentiles across every configured endpoint rather than an average -
 *      the tail is what causes a missed block, and an average hides it.
 *   2. The round-trip edge on one pair, sampled as fast as the endpoint allows,
 *      giving how many bps the edge drifts per 100 ms.
 *
 * Multiply those together and the answer is in dollars per month, which is the
 * only form in which the question can honestly be settled.
 */
import { JsonRpcProvider, Network } from 'ethers';
import { loadConfig } from '../config.js';
import { getChain, tokenBySymbol } from '../chains.js';
import { createChainContext } from '../onchain/provider.js';
import { validateChain } from '../onchain/validate.js';
import { discoverPools, filterV3ByDepth } from '../onchain/dex/index.js';
import { quoteV3Batch, type V3QuoteRequest } from '../onchain/dex/univ3.js';
import { PriceOracle } from '../onchain/prices.js';
import type { ChainName, TokenInfo } from '../types.js';
import type { V3Pool } from '../onchain/dex/pools.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function stats(values: number[]): {
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// ── part 1: endpoint latency ────────────────────────────────────────────────

/**
 * Time the exact call a scan makes, not a synthetic `eth_blockNumber`.
 *
 * `eth_blockNumber` is served from cache by every provider and would report a
 * latency we never actually experience. A batched `eth_call` through Multicall3
 * is what the scanner spends its time on, so that is what gets timed.
 */
async function measureEndpoints(
  chainName: ChainName,
  urls: string[],
  probe: V3QuoteRequest[],
  rounds: number,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  console.log(`\n=== endpoint latency (${chainName}, batched quote of ${probe.length} pools) ===`);
  console.log('  each figure is one full round-trip in ms\n');

  for (const url of urls) {
    // A real ChainContext, built through the same factory the bot uses. An
    // ad-hoc `{ provider }` object omits the Multicall3 contract, and
    // quoteV3Batch then fails internally and returns not-ok results instead of
    // throwing - which times a local failure at 1ms and looks like a
    // spectacularly fast endpoint. Timing the wrong thing silently is worse
    // than not measuring at all.
    const ctx = createChainContext(
      { ...config, rpcUrls: { ...config.rpcUrls, [chainName]: url } },
      getChain(chainName),
    );

    const samples: number[] = [];
    let failures = 0;

    for (let i = 0; i < rounds; i += 1) {
      const started = performance.now();
      try {
        const out = await quoteV3Batch(ctx, probe);
        // A batch that came back entirely not-ok did not measure the network.
        if (!out.some((r) => r.ok)) throw new Error('no successful quote in batch');
        samples.push(performance.now() - started);
      } catch {
        failures += 1;
      }
    }

    const host = new URL(url).host;
    if (samples.length === 0) {
      console.log(`  ${host.padEnd(38)} all ${rounds} calls failed or returned nothing usable`);
      continue;
    }
    const s = stats(samples);
    console.log(
      `  ${host.padEnd(38)} p50 ${s.p50.toFixed(0).padStart(5)}  ` +
        `p90 ${s.p90.toFixed(0).padStart(5)}  p99 ${s.p99.toFixed(0).padStart(5)}  ` +
        `min ${s.min.toFixed(0).padStart(5)}  max ${s.max.toFixed(0).padStart(5)}` +
        (failures > 0 ? `  (${failures}/${rounds} failed)` : ''),
    );
    ctx.provider.destroy();
  }
}

// ── part 2: how fast does the edge move? ────────────────────────────────────

interface EdgeSample {
  atMs: number;
  edgeBps: number;
}

/**
 * Sample the best two-leg round-trip edge on one pair as fast as possible.
 *
 * Both directions are quoted every sample. Deriving the return leg by
 * reciprocal would understate movement, because a reciprocal cannot express the
 * two pools disagreeing - which is the entire quantity being measured.
 */
async function measureEdgeDrift(
  ctx: never,
  pools: V3Pool[],
  base: TokenInfo,
  counter: TokenInfo,
  amountIn: bigint,
  counterIn: bigint,
  seconds: number,
): Promise<EdgeSample[]> {
  const fwdReqs: V3QuoteRequest[] = pools.map((p) => ({
    quoter: p.quoter,
    tokenIn: base,
    tokenOut: counter,
    feeTier: p.feeTier,
    amountIn,
  }));
  const revReqs: V3QuoteRequest[] = pools.map((p) => ({
    quoter: p.quoter,
    tokenIn: counter,
    tokenOut: base,
    feeTier: p.feeTier,
    amountIn: counterIn,
  }));

  const samples: EdgeSample[] = [];
  const startedAt = performance.now();

  while (performance.now() - startedAt < seconds * 1000) {
    const at = performance.now() - startedAt;
    try {
      const [fwd, rev] = await Promise.all([
        quoteV3Batch(ctx, fwdReqs),
        quoteV3Batch(ctx, revReqs),
      ]);

      // Best achievable round trip: sell on one pool, buy back on another.
      let best = -Infinity;
      for (let i = 0; i < fwd.length; i += 1) {
        const sell = fwd[i];
        if (!sell?.ok || sell.amountOut <= 0n) continue;
        const counterOut = Number(sell.amountOut) / 10 ** counter.decimals;
        for (let j = 0; j < rev.length; j += 1) {
          if (i === j) continue;
          const buy = rev[j];
          if (!buy?.ok || buy.amountOut <= 0n) continue;
          // Scale the measured reverse quote to the size actually produced by
          // the first leg. Linear scaling is an approximation, but it is applied
          // identically to every sample, so it cannot bias the *drift* - which
          // is the only quantity this function reports.
          const counterProbe = Number(counterIn) / 10 ** counter.decimals;
          const baseBack =
            (Number(buy.amountOut) / 10 ** base.decimals) * (counterOut / counterProbe);
          const inFloat = Number(amountIn) / 10 ** base.decimals;
          const edge = (baseBack / inFloat - 1) * 10_000;
          if (edge > best) best = edge;
        }
      }
      if (Number.isFinite(best)) samples.push({ atMs: at, edgeBps: best });
    } catch {
      // A dropped sample is a gap, not a data point. Recording it as zero drift
      // would make a rate-limited endpoint look like a calm market.
    }
  }

  return samples;
}

async function main(): Promise<void> {
  const chainName = arg('chain', 'base') as ChainName;
  const rounds = Number(arg('rounds', '12'));
  const driftSeconds = Number(arg('seconds', '45'));
  const pairArg = arg('pair', 'WETH/USDC');

  const config = loadConfig();
  const chain = getChain(chainName);
  const ctx = createChainContext(config, chain);

  const [baseSym, counterSym] = pairArg.split('/');
  const base = tokenBySymbol(chain, baseSym ?? 'WETH');
  const counter = tokenBySymbol(chain, counterSym ?? 'USDC');

  const validation = await validateChain(ctx);
  const pools = await discoverPools(ctx, validation.enabledVenueIds);
  const oracle = new PriceOracle(chain);
  oracle.refresh(pools);

  const priceOf = (t: TokenInfo): number => oracle.usd(t);
  const { kept } = await filterV3ByDepth(ctx, pools.v3, config.minPoolLiquidityUsd, priceOf);

  const pairPools = kept.filter(
    (p) =>
      (p.tokenA.symbol === base.symbol && p.tokenB.symbol === counter.symbol) ||
      (p.tokenB.symbol === base.symbol && p.tokenA.symbol === counter.symbol),
  );

  console.log(
    `chain=${chainName} pair=${base.symbol}/${counter.symbol} ` +
      `v3 pools with depth=${pairPools.length}`,
  );
  if (pairPools.length < 2) {
    console.log('need at least two pools on the pair to have a round trip to measure');
    process.exit(1);
  }

  const basePrice = oracle.usd(base);
  const counterPrice = oracle.usd(counter);
  const amountIn = BigInt(
    Math.floor((config.minTradeUsd / basePrice) * 10 ** base.decimals),
  );
  const counterIn = BigInt(
    Math.floor((config.minTradeUsd / counterPrice) * 10 ** counter.decimals),
  );

  const probe: V3QuoteRequest[] = pairPools.map((p) => ({
    quoter: p.quoter,
    tokenIn: base,
    tokenOut: counter,
    feeTier: p.feeTier,
    amountIn,
  }));

  // The configured endpoint first, then any other endpoint we already know about
  // for this chain. Comparing them is the point: if the spread between free
  // endpoints is larger than what a paid one would save, the bottleneck is
  // endpoint choice, not endpoint tier.
  const candidates = [
    config.rpcUrls[chainName],
    ...(config.logsRpcUrls[chainName] ?? []),
  ].filter((u, i, all): u is string => Boolean(u) && all.indexOf(u) === i);

  await measureEndpoints(chainName, candidates, probe, rounds, config);

  console.log(`\n=== edge drift (${base.symbol}/${counter.symbol}, ${driftSeconds}s) ===`);
  const samples = await measureEdgeDrift(
    ctx as never,
    pairPools,
    base,
    counter,
    amountIn,
    counterIn,
    driftSeconds,
  );

  if (samples.length < 3) {
    console.log(`  only ${samples.length} samples collected - endpoint is too slow to measure`);
    process.exit(1);
  }

  const intervals: number[] = [];
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev || !cur) continue;
    intervals.push(cur.atMs - prev.atMs);
    deltas.push(Math.abs(cur.edgeBps - prev.edgeBps));
  }

  const edges = samples.map((s) => s.edgeBps);
  const e = stats(edges);
  const iv = stats(intervals);
  const meanInterval = intervals.reduce((a, b) => a + b, 0) / Math.max(1, intervals.length);
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const driftPer100ms = meanInterval > 0 ? (meanDelta / meanInterval) * 100 : 0;

  console.log(`  samples: ${samples.length} over ${driftSeconds}s`);
  console.log(
    `  achieved sample interval: p50 ${iv.p50.toFixed(0)}ms  p90 ${iv.p90.toFixed(0)}ms`,
  );
  console.log(
    `  edge bps:  min ${e.min.toFixed(2)}  p50 ${e.p50.toFixed(2)}  ` +
      `p90 ${e.p90.toFixed(2)}  max ${e.max.toFixed(2)}`,
  );
  console.log(`  full excursion: ${(e.max - e.min).toFixed(2)} bps`);
  console.log(`  mean |change| between samples: ${meanDelta.toFixed(3)} bps`);
  console.log(`  => drift rate: ${driftPer100ms.toFixed(3)} bps per 100ms`);

  // What a faster endpoint is actually worth. Latency does not create edge; it
  // only decides how much of an existing edge has already decayed by the time
  // we could act. Saving `d` ms is therefore worth `driftRate * d` bps - and
  // only on trades we would otherwise have taken anyway.
  console.log('\n=== what latency is worth ===');
  for (const savedMs of [100, 250, 500]) {
    const bps = (driftPer100ms * savedMs) / 100;
    const perTrade = (bps / 10_000) * config.maxTradeUsd;
    console.log(
      `  saving ${String(savedMs).padStart(3)}ms  =>  ${bps.toFixed(3)} bps  ` +
        `=  $${perTrade.toFixed(2)} per $${config.maxTradeUsd} trade`,
    );
  }
  console.log(
    `\n  a $200/mo endpoint needs ${(200 / ((driftPer100ms * 250) / 10_000 * config.maxTradeUsd || 1)).toFixed(0)}` +
      ` such trades per month to pay for itself (at 250ms saved)`,
  );

  process.exit(0);
}

void main();
