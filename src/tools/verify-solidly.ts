/**
 * Cross-check the local Solidly curve math against the pools themselves, and
 * confirm every configured Curve pool actually answers.
 *
 * This exists because both failure modes are silent. A wrong `x³y + y³x = k`
 * solver does not throw — it returns a plausible number, the scanner believes
 * it, and the bot reports profits that were never available. Likewise a stale
 * Curve pool address simply yields nothing, and the venue looks "quiet" rather
 * than broken.
 *
 * Run with: npm run verify:solidly
 */
import { Contract } from 'ethers';
import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { createChainContext } from '../onchain/provider';
import { getAmountOutSolidly, discoverSolidlyPools, refreshSolidlyReserves } from '../onchain/dex/solidly';
import { discoverCurvePools, quoteCurveBatch } from '../onchain/dex/curve';
import { getChain, tokenBySymbol } from '../chains';
import type { TokenInfo } from '../types';

const log = createLogger('verify');

const SOLIDLY_POOL_ABI = [
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)',
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function token0() view returns (address)',
];

/**
 * Tolerance, in wei, for the stable-curve comparison.
 *
 * Not a fudge factor for a wrong formula. Aerodrome solves `x³y + y³x = k` by
 * Newton-Raphson and stops when successive iterates are within 1 wei; two
 * implementations that both converge correctly can therefore land on adjacent
 * integers. Anything larger than a couple of wei is a real divergence, and at
 * trade size a real divergence shows up as a percentage, not as wei.
 */
const STABLE_TOLERANCE_WEI = 2n;

/** Sizes spanning four orders of magnitude: the curve's shape only matters at scale. */
const PROBE_FRACTIONS = [0.0001, 0.001, 0.01, 0.05];

async function main(): Promise<void> {
  const config = loadConfig();
  let checked = 0;
  let mismatched = 0;

  for (const chainKey of config.chains) {
    const chain = getChain(chainKey);
    const ctx = createChainContext(config, chain);

    const pairs: Array<[TokenInfo, TokenInfo]> = [];
    for (const [a, b] of chain.pairs) {
      const tokenA = tokenBySymbol(chain, a);
      const tokenB = tokenBySymbol(chain, b);
      if (tokenA && tokenB) pairs.push([tokenA, tokenB]);
    }

    // ── Solidly: local math must equal the pool's own quote ──────────────────
    for (const venue of chain.venues.filter((v) => v.kind === 'solidly')) {
      const discovered = await discoverSolidlyPools(ctx, venue, pairs);
      // Discovery resolves addresses and fees but leaves reserves at zero; without
      // this refresh every comparison below would be skipped and the run would
      // pass while checking nothing.
      const pools = await refreshSolidlyReserves(ctx, discovered);
      log.info('solidly pools discovered', {
        chain: chainKey,
        venue: venue.id,
        n: pools.length,
        withReserves: pools.filter((p) => p.reserveA > 0n && p.reserveB > 0n).length,
      });

      for (const pool of pools) {
        const contract = new Contract(pool.pool, SOLIDLY_POOL_ABI, ctx.provider);

        // Pin every read for this pool to one block. Without this the comparison
        // is meaningless on an active pool: reserves are read at block N and the
        // quote answered at N+2, and any trade in between shows up as a constant
        // percentage drift that looks exactly like a formula bug.
        const blockTag = await ctx.provider.getBlockNumber();

        let reserve0: bigint;
        let reserve1: bigint;
        let token0: string;
        try {
          const reserves = (await contract.getReserves!({ blockTag })) as [bigint, bigint, bigint];
          reserve0 = reserves[0];
          reserve1 = reserves[1];
          token0 = ((await contract.token0!({ blockTag })) as string).toLowerCase();
        } catch {
          log.warn('solidly pool did not expose reserves, skipping', { pool: pool.pool });
          continue;
        }

        const aIsToken0 = pool.tokenA.address.toLowerCase() === token0;
        const reserveAAt = aIsToken0 ? reserve0 : reserve1;
        const reserveBAt = aIsToken0 ? reserve1 : reserve0;

        for (const aToB of [true, false]) {
          const tokenIn = aToB ? pool.tokenA : pool.tokenB;
          const reserveIn = aToB ? reserveAAt : reserveBAt;
          const reserveOut = aToB ? reserveBAt : reserveAAt;
          const scaleIn = aToB ? pool.scaleA : pool.scaleB;
          const scaleOut = aToB ? pool.scaleB : pool.scaleA;
          if (reserveIn <= 0n || reserveOut <= 0n) continue;

          for (const fraction of PROBE_FRACTIONS) {
            const amountIn = (reserveIn * BigInt(Math.round(fraction * 1_000_000))) / 1_000_000n;
            if (amountIn <= 0n) continue;

            const local = getAmountOutSolidly(
              amountIn,
              reserveIn,
              reserveOut,
              scaleIn,
              scaleOut,
              pool.feeBps,
              pool.stable,
            );

            let onchain: bigint;
            try {
              onchain = (await contract.getAmountOut!(amountIn, tokenIn.address, {
                blockTag,
              })) as bigint;
            } catch {
              continue;
            }

            checked += 1;

            // Volatile pools are closed-form, so they must match to the wei.
            // Stable pools are solved iteratively and are allowed to land on an
            // adjacent integer — but no more than that.
            const delta = local > onchain ? local - onchain : onchain - local;
            const allowed = pool.stable ? STABLE_TOLERANCE_WEI : 0n;

            if (delta > allowed) {
              mismatched += 1;
              const drift =
                onchain > 0n ? Number(((local - onchain) * 1_000_000n) / onchain) / 10_000 : NaN;
              log.error('SOLIDLY MATH MISMATCH', {
                pool: pool.pool,
                pair: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
                stable: pool.stable,
                feeBps: pool.feeBps,
                tokenIn: tokenIn.symbol,
                amountIn: amountIn.toString(),
                local: local.toString(),
                onchain: onchain.toString(),
                driftPct: drift,
              });
            }
          }
        }

        log.info('solidly pool verified', {
          pool: pool.pool,
          pair: `${pool.tokenA.symbol}/${pool.tokenB.symbol}`,
          stable: pool.stable,
          feeBps: pool.feeBps,
        });
      }
    }

    // ── Curve: every configured pool must resolve and quote ─────────────────
    for (const venue of chain.venues.filter((v) => v.kind === 'curve')) {
      const configured = venue.curvePools?.length ?? 0;
      const pools = await discoverCurvePools(ctx, venue, chain.tokens);
      log.info('curve pools resolved', {
        chain: chainKey,
        configured,
        resolved: pools.length,
        pairs: pools.map((p) => `${p.tokenA.symbol}/${p.tokenB.symbol}`),
      });

      if (pools.length === 0 && configured > 0) {
        log.error('CURVE: no configured pool resolved — addresses are wrong or dead', {
          chain: chainKey,
          configured: venue.curvePools,
        });
        mismatched += 1;
        continue;
      }

      const quotes = await quoteCurveBatch(
        ctx,
        pools.map((pool) => ({
          pool,
          aToB: true,
          amountIn: 10n ** BigInt(pool.tokenA.decimals),
        })),
      );

      for (let i = 0; i < pools.length; i += 1) {
        const pool = pools[i];
        const out = quotes[i];
        if (!pool) continue;
        if (out === undefined || out <= 0n) {
          mismatched += 1;
          log.error('CURVE: pool did not quote', { pool: pool.pool });
          continue;
        }
        checked += 1;
        const outFloat = Number(out) / 10 ** pool.tokenB.decimals;
        log.info('curve pool quotes', {
          pool: pool.pool,
          route: `1 ${pool.tokenA.symbol} -> ${outFloat} ${pool.tokenB.symbol}`,
          int128: pool.int128Indices,
        });
      }
    }
  }

  log.info('verification complete', { checked, mismatched });

  if (checked === 0) {
    log.error('nothing was verified — no Solidly or Curve pool responded at all');
    process.exit(1);
  }
  // A non-zero exit is the point: this must be able to fail a deploy.
  process.exit(mismatched === 0 ? 0 : 1);
}

main().catch((err) => {
  log.error('verification crashed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
