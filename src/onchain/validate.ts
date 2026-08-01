/**
 * Startup validation.
 *
 * Hardcoded addresses are a classic source of silent failure: point a quoter at
 * the wrong address and you get reverts that look like "no opportunities" rather
 * than a config bug. So before scanning, confirm every contract we depend on is
 * actually deployed, and disable any venue that fails instead of trusting it.
 */

import { Interface } from 'ethers';
import { UNIV2_FACTORY_ABI, UNIV3_FACTORY_ABI } from './abi';
import { isZeroAddress, multicall, type ChainContext } from './provider';
import { tokenBySymbol } from '../chains';
import { createLogger, errMeta } from '../logger';
import type { DexVenue } from '../types';

const log = createLogger('validate');

const univ2Factory = new Interface(UNIV2_FACTORY_ABI);
const univ3Factory = new Interface(UNIV3_FACTORY_ABI);

export interface ChainValidation {
  chainOk: boolean;
  blockNumber?: number;
  /** Venues that responded correctly and may be used. */
  enabledVenueIds: Set<string>;
  /** Venue id -> reason it was rejected. */
  disabled: Record<string, string>;
  aavePoolOk: boolean;
  balancerVaultOk: boolean;
  multicallOk: boolean;
}

async function hasCode(ctx: ChainContext, address?: string): Promise<boolean> {
  if (!address || isZeroAddress(address)) return false;
  try {
    const code = await ctx.provider.getCode(address);
    return code !== undefined && code !== '0x' && code.length > 2;
  } catch {
    return false;
  }
}

/**
 * A factory is only trusted if it can resolve a pool for the chain's primary
 * pair. `getCode` alone proves something is deployed, not that it is the right
 * something.
 */
async function validateVenue(ctx: ChainContext, venue: DexVenue): Promise<string | undefined> {
  if (!(await hasCode(ctx, venue.router))) return 'router has no bytecode';
  if (!(await hasCode(ctx, venue.factory))) return 'factory has no bytecode';
  if (venue.kind === 'univ3' && !(await hasCode(ctx, venue.quoter))) {
    return 'quoter has no bytecode';
  }

  const primaryPair = ctx.chain.pairs[0];
  if (!primaryPair) return undefined;

  let tokenA;
  let tokenB;
  try {
    tokenA = tokenBySymbol(ctx.chain, primaryPair[0]);
    tokenB = tokenBySymbol(ctx.chain, primaryPair[1]);
  } catch {
    return undefined;
  }

  try {
    if (venue.kind === 'univ2') {
      const [result] = await multicall(ctx, [
        {
          target: venue.factory as string,
          callData: univ2Factory.encodeFunctionData('getPair', [tokenA.address, tokenB.address]),
        },
      ]);
      if (!result?.success) return 'factory getPair reverted';
      const pair = univ2Factory.decodeFunctionResult('getPair', result.returnData)[0] as string;
      if (isZeroAddress(pair)) {
        return `no ${tokenA.symbol}/${tokenB.symbol} pair — wrong factory or dead venue`;
      }
    } else {
      const tiers = venue.feeTiers ?? [500, 3000];
      const calls = tiers.map((fee) => ({
        target: venue.factory as string,
        callData: univ3Factory.encodeFunctionData('getPool', [
          tokenA.address,
          tokenB.address,
          fee,
        ]),
      }));
      const results = await multicall(ctx, calls);
      const anyPool = results.some((r) => {
        if (!r.success || r.returnData === '0x') return false;
        try {
          const pool = univ3Factory.decodeFunctionResult('getPool', r.returnData)[0] as string;
          return !isZeroAddress(pool);
        } catch {
          return false;
        }
      });
      if (!anyPool) {
        return `no ${tokenA.symbol}/${tokenB.symbol} pool on any fee tier — wrong factory`;
      }
    }
  } catch (err) {
    return `factory probe threw: ${err instanceof Error ? err.message : String(err)}`;
  }

  return undefined;
}

export async function validateChain(ctx: ChainContext): Promise<ChainValidation> {
  const validation: ChainValidation = {
    chainOk: false,
    enabledVenueIds: new Set<string>(),
    disabled: {},
    aavePoolOk: false,
    balancerVaultOk: false,
    multicallOk: false,
  };

  try {
    const [blockNumber, network] = await Promise.all([
      ctx.provider.getBlockNumber(),
      ctx.provider.getNetwork(),
    ]);
    validation.blockNumber = blockNumber;

    if (Number(network.chainId) !== ctx.chain.chainId) {
      log.error('RPC chain id mismatch — check your RPC URL', {
        chain: ctx.chain.name,
        expected: ctx.chain.chainId,
        actual: Number(network.chainId),
      });
      return validation;
    }
    validation.chainOk = true;
  } catch (err) {
    log.error('cannot reach RPC', { chain: ctx.chain.name, ...errMeta(err) });
    return validation;
  }

  validation.multicallOk = await hasCode(ctx, ctx.chain.multicall3);
  validation.aavePoolOk = await hasCode(ctx, ctx.chain.aavePool);
  validation.balancerVaultOk = await hasCode(ctx, ctx.chain.balancerVault);

  if (!validation.multicallOk) {
    log.error('Multicall3 not found — batched quoting is unavailable', {
      chain: ctx.chain.name,
      multicall3: ctx.chain.multicall3,
    });
    validation.chainOk = false;
    return validation;
  }

  for (const venue of ctx.chain.venues) {
    const problem = await validateVenue(ctx, venue);
    if (problem) {
      validation.disabled[venue.id] = problem;
      log.warn('venue disabled', { chain: ctx.chain.name, venue: venue.id, reason: problem });
    } else {
      validation.enabledVenueIds.add(venue.id);
    }
  }

  log.info('chain validated', {
    chain: ctx.chain.name,
    block: validation.blockNumber,
    enabledVenues: [...validation.enabledVenueIds],
    disabledVenues: Object.keys(validation.disabled),
    aave: validation.aavePoolOk,
    balancer: validation.balancerVaultOk,
  });

  return validation;
}
