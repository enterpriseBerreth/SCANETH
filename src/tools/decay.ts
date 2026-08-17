/**
 * Decay-vs-delay measurement.
 *
 * We know edges die between detection and settlement, but we do not know where
 * in that interval the death happens. If the edge is already gone at 100ms,
 * paid infra is worthless. If it survives until 500ms but dies by 3000ms, then
 * latency is the right lever. This tool fixes that ambiguity by re-quoting the
 * same candidate at multiple delays inside one invocation.
 *
 * Output is a table: delay -> best edge bps. The shape of that curve, not a
 * single number, decides what to do next.
 */
import { loadConfig } from '../config.js';
import { getChain } from '../chains.js';
import { createChainContext } from '../onchain/provider.js';
import { validateChain } from '../onchain/validate.js';
import { discoverPools } from '../onchain/dex/index.js';
import { scanChainVerbose, requoteCycle } from '../onchain/scanner.js';
import { PriceOracle } from '../onchain/prices.js';
import { flashFee, gasCostUsd, estimateRouteGas } from '../onchain/profit.js';
import type { ArbOpportunity, ChainName } from '../types.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const chainName = arg('chain', 'arbitrum') as ChainName;
  const pairArg = arg('pair', 'WETH/LINK');
  const maxEdgeBps = Number(arg('max-edge-bps', '2'));
  const delays = arg('delays', '0,100,250,500,1000,3000')
    .split(',')
    .map((s) => Number(s.trim()));

  const config = loadConfig();
  // Override the profit floor so the tool can see candidates below the live
  // send threshold. We are measuring decay, not deciding whether to send.
  const toolConfig = { ...config, minProfitUsd: -Infinity };
  const chain = getChain(chainName);
  const ctx = createChainContext(toolConfig, chain);

  const validation = await validateChain(ctx);
  const pools = await discoverPools(ctx, validation.enabledVenueIds);
  const oracle = new PriceOracle(chain);
  oracle.refresh(pools);

  const gasPriceWei = (await ctx.provider.getFeeData()).gasPrice ?? 1_000_000n;
  const gasPriceGwei = Number(gasPriceWei) / 1e9;
  const nativeUsd = oracle.nativeUsd();
  const flashFeeBps = chain.balancerVault ? 0 : chain.aavePool ? 9 : 0;

  console.log(`chain=${chainName} pair=${pairArg} gas=${gasPriceGwei.toFixed(4)} gwei native=$${nativeUsd.toFixed(2)}`);

  // Find the best candidate for the requested pair by scanning once.
  const scan = await scanChainVerbose({ ctx, pools, oracle, config: toolConfig, gasPriceWei, rawMode: true });
  console.log(`scan found ${scan.actionable.length} actionable, ${scan.nearMisses.length} near misses, bestEdgeBps=${scan.diagnostics.bestEdgeBps?.toFixed(2) ?? 'null'}`);
  const [baseSym, quoteSym] = pairArg.split('/');
  const matchesPair = (o: ArbOpportunity): boolean =>
    o.baseToken.symbol === baseSym &&
    o.legs.some(
      (l) => l.tokenOut.symbol === quoteSym || l.tokenIn.symbol === quoteSym,
    );

  const allCandidates = [...scan.actionable, ...scan.nearMisses].filter(matchesPair);
  const best = allCandidates[0];
  if (!best) {
    console.log('no candidate for this pair in current block');
    process.exit(0);
  }

  const routeLabel = best.legs.map((l) => `${l.tokenIn.symbol}>${l.tokenOut.symbol}`).join(' ');
  const detectedEdgeBps = (best.netProfitUsd / best.notionalUsd) * 10_000;
  console.log(`candidate: ${routeLabel} detected-edge=${detectedEdgeBps.toFixed(2)}bps net=$${best.netProfitUsd.toFixed(4)} size=$${best.notionalUsd.toFixed(2)}`);

  const routeGas = estimateRouteGas(best.legs, !!chain.balancerVault);
  const gasUsd = gasCostUsd(routeGas, gasPriceWei, nativeUsd);

  // Requote requires a ScanContext; build one from the live state. rawMode lets
  // us observe cycles that are below the live profit floor or even negative.
  const scanCtx = { ctx, pools, oracle, config: toolConfig, gasPriceWei, rawMode: true };

  console.log('\n=== decay by delay ===');
  console.log('delay_ms  edge_bps  net_usd  outcome');

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);

    const { amountOut, quoted } = await requoteCycle(scanCtx, best.legs, best.amountIn);
    let edgeBps = -Infinity;
    let netUsd = 0;
    let outcome = 'unquotable';

    if (quoted) {
      const owed = best.amountIn + flashFee(best.amountIn, flashFeeBps);
      const profit = amountOut - owed;
      const basePrice = oracle.usd(best.baseToken);
      const profitUsd =
        basePrice > 0
          ? (Number(profit) / 10 ** best.baseToken.decimals) * basePrice
          : 0;
      netUsd = profitUsd - gasUsd;
      edgeBps = (netUsd / best.notionalUsd) * 10_000;
      outcome = netUsd >= config.minProfitUsd ? 'fills' : netUsd > 0 ? 'profitable-below-floor' : 'unprofitable';
    }

    console.log(
      `${String(delay).padStart(6)}  ${edgeBps === -Infinity ? 'N/A'.padStart(8) : edgeBps.toFixed(2).padStart(8)}  ${netUsd === 0 && !quoted ? 'N/A'.padStart(8) : netUsd.toFixed(4).padStart(8)}  ${outcome}`,
    );
  }

  process.exit(0);
}

void main();
