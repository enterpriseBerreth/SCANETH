/**
 * Diagnostics: `npm run doctor`
 *
 * Connects to every enabled chain and verifies the whole read path — RPC
 * reachability, chain id, Multicall3, flash-loan providers, each venue's
 * factory/quoter, pool discovery and a live quote. Run this first whenever the
 * bot reports "no opportunities": it distinguishes a quiet market from a broken
 * configuration.
 */

import { loadConfig } from '../config';
import { getChain, tokenBySymbol } from '../chains';
import { createChainContext, getGasPriceWei } from '../onchain/provider';
import { validateChain } from '../onchain/validate';
import { discoverPools, refreshPools, v2LiquidityUsd, v2SpotPrice } from '../onchain/dex';
import { quoteV3Batch, impliedPrice } from '../onchain/dex/univ3';
import { toBigInt } from '../onchain/profit';
import { formatUnits } from 'ethers';

async function main(): Promise<void> {
  const config = loadConfig();

  console.log('\n=== ARBO doctor ===');
  console.log(`mode          : ${config.mode}`);
  console.log(`chains        : ${config.chains.join(', ')}`);
  console.log(`min profit    : $${config.minProfitUsd}`);
  console.log(`trade size    : $${config.minTradeUsd} .. $${config.maxTradeUsd}`);

  let anyFailure = false;

  for (const chainName of config.chains) {
    const chain = getChain(chainName);
    const ctx = createChainContext(config, chain);

    console.log(`\n--- ${chain.label} (chainId ${chain.chainId}) ---`);

    const validation = await validateChain(ctx);
    if (!validation.chainOk) {
      console.log('  RPC          : UNREACHABLE or wrong chain');
      anyFailure = true;
      continue;
    }

    const gasPrice = await getGasPriceWei(ctx.provider);
    console.log(`  block        : ${validation.blockNumber}`);
    console.log(`  gas price    : ${formatUnits(gasPrice, 'gwei')} gwei`);
    console.log(`  multicall3   : ${validation.multicallOk ? 'ok' : 'MISSING'}`);
    console.log(`  aave v3 pool : ${validation.aavePoolOk ? 'ok' : 'MISSING'}`);
    console.log(`  balancer vault: ${validation.balancerVaultOk ? 'ok' : 'MISSING'}`);
    console.log(`  contract     : ${ctx.contractAddress ?? '(not deployed — scan only)'}`);

    console.log(`  venues enabled : ${[...validation.enabledVenueIds].join(', ') || 'NONE'}`);
    for (const [venueId, reason] of Object.entries(validation.disabled)) {
      console.log(`  venue DISABLED : ${venueId} -> ${reason}`);
      anyFailure = true;
    }

    const pools = await discoverPools(ctx, validation.enabledVenueIds);
    const live = await refreshPools(ctx, pools);

    console.log(`  pools        : ${live.v2.length} v2 (with liquidity), ${live.v3.length} v3`);

    // Show real V2 prices so it is obvious the data is genuine.
    const shown = live.v2
      .slice()
      .sort((a, b) => v2LiquidityUsd(b) - v2LiquidityUsd(a))
      .slice(0, 6);
    for (const pool of shown) {
      const price = v2SpotPrice(pool, true);
      console.log(
        `    v2 ${pool.venueId.padEnd(14)} ${pool.tokenA.symbol}/${pool.tokenB.symbol}` +
          ` price=${price.toPrecision(8)} liq=$${v2LiquidityUsd(pool).toFixed(0)}`,
      );
    }

    // Live V3 quote: 1 unit of the chain's primary token.
    const primary = chain.pairs[0];
    if (primary && live.v3.length > 0) {
      const tokenA = tokenBySymbol(chain, primary[0]);
      const tokenB = tokenBySymbol(chain, primary[1]);
      const candidates = live.v3.filter(
        (p) =>
          p.tokenA.address.toLowerCase() === tokenA.address.toLowerCase() &&
          p.tokenB.address.toLowerCase() === tokenB.address.toLowerCase(),
      );
      const requests = candidates.map((p) => ({
        quoter: p.quoter,
        tokenIn: tokenA,
        tokenOut: tokenB,
        feeTier: p.feeTier,
        amountIn: toBigInt(1, tokenA.decimals),
      }));
      const quotes = await quoteV3Batch(ctx, requests);
      for (const quote of quotes) {
        const status = quote.ok ? impliedPrice(quote).toPrecision(8) : 'no liquidity';
        console.log(
          `    v3 fee=${String(quote.feeTier).padStart(5)} ` +
            `1 ${tokenA.symbol} -> ${status} ${tokenB.symbol}`,
        );
      }
      if (quotes.length > 0 && !quotes.some((q) => q.ok)) {
        console.log('    WARNING: every v3 quote failed — check the quoter address');
        anyFailure = true;
      }
    }

    if (live.v2.length === 0 && live.v3.length === 0) {
      console.log('  WARNING: no usable pools found on this chain');
      anyFailure = true;
    }
  }

  console.log(
    `\n=== ${anyFailure ? 'COMPLETED WITH WARNINGS' : 'ALL CHECKS PASSED'} ===\n`,
  );
  if (anyFailure) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\ndoctor failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
