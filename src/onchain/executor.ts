/**
 * Execution path.
 *
 * Three independent safety layers, because an arbitrage bot that fires blindly
 * bleeds gas on reverts:
 *
 *   1. Mode guard      — in `simulate` mode this module physically cannot
 *                        broadcast. The check happens before any calldata is
 *                        built, not as a flag passed downstream.
 *   2. eth_call replay — every candidate is replayed against current state
 *                        before it is sent. Reverts are discarded for free.
 *   3. On-chain floor  — `minProfit` is embedded in the transaction, so if the
 *                        opportunity decays between simulation and inclusion the
 *                        contract reverts rather than completing at a loss. Cost
 *                        of a decayed opportunity is gas, never principal.
 */

import { Contract, Interface, type TransactionReceipt } from 'ethers';
import { ARBO_FLASH_ARB_ABI } from './abi';
import { getGasPriceWei, type ChainContext } from './provider';
import { gasCostUsd, valueUsd } from './profit';
import type { PriceOracle } from './prices';
import { canExecuteOnChain, type ArboConfig } from '../config';
import { createLogger, errMeta } from '../logger';
import type { ArbOpportunity, ExecutionResult, RouteLeg } from '../types';

const log = createLogger('executor');

const arboIface = new Interface(ARBO_FLASH_ARB_ABI);

/** Must match the SwapKind enum in ArboFlashArb.sol. */
const SWAP_KIND: Record<RouteLeg['kind'], number> = {
  univ2: 0,
  univ3: 1,
};

interface EncodedSwap {
  router: string;
  kind: number;
  tokenIn: string;
  tokenOut: string;
  feeTier: number;
}

function encodeSwaps(legs: RouteLeg[]): EncodedSwap[] {
  return legs.map((leg) => ({
    router: leg.router,
    kind: SWAP_KIND[leg.kind],
    tokenIn: leg.tokenIn.address,
    tokenOut: leg.tokenOut.address,
    feeTier: leg.kind === 'univ3' ? leg.feeTier : 0,
  }));
}

/**
 * The profit floor written into the transaction.
 *
 * Set slightly below the simulated profit so ordinary block-to-block drift does
 * not cause needless reverts, but high enough that a materially worse fill is
 * rejected. This is the difference between "lost some gas" and "lost money".
 */
function onChainMinProfit(opportunity: ArbOpportunity, slippageBps: number): bigint {
  const tolerance = BigInt(Math.max(0, Math.min(10_000, slippageBps)));
  const floor = (opportunity.grossProfit * (10_000n - tolerance)) / 10_000n;
  return floor > 0n ? floor : 1n;
}

export interface ExecuteDeps {
  ctx: ChainContext;
  config: ArboConfig;
  oracle: PriceOracle;
}

export async function executeOpportunity(
  deps: ExecuteDeps,
  opportunity: ArbOpportunity,
): Promise<ExecutionResult> {
  const { ctx, config, oracle } = deps;

  // ── Layer 1: mode guard ───────────────────────────────────────────────────
  if (!canExecuteOnChain(config, ctx.chain.name)) {
    const reason =
      config.mode !== 'live'
        ? 'simulate mode — no transaction sent'
        : config.killSwitch
          ? 'kill switch engaged'
          : !ctx.contractAddress
            ? 'no flash-loan contract deployed on this chain'
            : 'no executor key configured';
    return { opportunityId: opportunity.id, submitted: false, reason };
  }

  if (!ctx.wallet) {
    return { opportunityId: opportunity.id, submitted: false, reason: 'no wallet' };
  }

  const contract = new Contract(ctx.contractAddress as string, ARBO_FLASH_ARB_ABI, ctx.wallet);
  const swaps = encodeSwaps(opportunity.legs);
  const minProfit = onChainMinProfit(opportunity, config.slippageBps);

  const args = [
    opportunity.flashProvider,
    opportunity.baseToken.address,
    opportunity.amountIn,
    swaps,
    minProfit,
  ] as const;

  // ── Layer 2: replay against current state ─────────────────────────────────
  try {
    const executeArb = contract.getFunction('executeArb');
    await executeArb.staticCall(...args, { from: ctx.wallet.address });
  } catch (err) {
    // Expected and cheap: the edge closed, or another searcher took it.
    log.debug('simulation reverted, skipping', {
      chain: ctx.chain.name,
      route: describeRoute(opportunity),
      ...errMeta(err),
    });
    return {
      opportunityId: opportunity.id,
      submitted: false,
      reason: `simulation reverted: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`,
    };
  }

  // Re-cost with a real gas estimate. The fallback is this route's modelled
  // gas rather than a flat config constant, so a failed estimate still costs
  // the trade according to its own shape.
  let gasLimit = opportunity.gasUnits > 0n ? opportunity.gasUnits : config.gasLimitEstimate;
  try {
    const executeArb = contract.getFunction('executeArb');
    const estimated = await executeArb.estimateGas(...args, { from: ctx.wallet.address });
    // 25% headroom; flash-loan callbacks vary with pool state.
    gasLimit = (estimated * 125n) / 100n;
  } catch (err) {
    log.debug('gas estimation failed, using configured limit', errMeta(err));
  }

  const gasPriceWei = await getGasPriceWei(ctx.submitProvider);
  const nativeUsd = oracle.nativeUsd();
  const realGasUsd = gasCostUsd(gasLimit, gasPriceWei, nativeUsd);
  const netAfterRealGas = opportunity.grossProfitUsd - realGasUsd;

  if (netAfterRealGas < config.minProfitUsd) {
    return {
      opportunityId: opportunity.id,
      submitted: false,
      reason: `net $${netAfterRealGas.toFixed(2)} below floor $${config.minProfitUsd} after real gas $${realGasUsd.toFixed(2)}`,
    };
  }

  // ── Broadcast ─────────────────────────────────────────────────────────────
  try {
    const executeArb = contract.getFunction('executeArb');
    const tx = await executeArb.send(...args, { gasLimit });

    log.info('transaction submitted', {
      chain: ctx.chain.name,
      txHash: tx.hash,
      route: describeRoute(opportunity),
      expectedNetUsd: Number(netAfterRealGas.toFixed(2)),
    });

    const receipt = (await tx.wait(1)) as TransactionReceipt | null;
    if (!receipt) {
      return {
        opportunityId: opportunity.id,
        submitted: true,
        txHash: tx.hash,
        reason: 'receipt unavailable',
      };
    }

    const gasSpentUsd = gasCostUsd(
      receipt.gasUsed,
      receipt.gasPrice ?? gasPriceWei,
      nativeUsd,
    );

    if (receipt.status === 0) {
      log.warn('transaction reverted on chain', { chain: ctx.chain.name, txHash: tx.hash });
      return {
        opportunityId: opportunity.id,
        submitted: true,
        txHash: tx.hash,
        reason: 'reverted on chain',
        realisedProfitUsd: -gasSpentUsd,
        gasSpentUsd,
      };
    }

    const realisedProfit = parseRealisedProfit(receipt);
    const realisedProfitUsd =
      realisedProfit === undefined
        ? opportunity.grossProfitUsd - gasSpentUsd
        : valueUsd(realisedProfit, opportunity.baseToken, oracle.usd(opportunity.baseToken)) -
          gasSpentUsd;

    log.info('arbitrage executed', {
      chain: ctx.chain.name,
      txHash: tx.hash,
      realisedProfitUsd: Number(realisedProfitUsd.toFixed(2)),
      gasSpentUsd: Number(gasSpentUsd.toFixed(2)),
    });

    return {
      opportunityId: opportunity.id,
      submitted: true,
      txHash: tx.hash,
      realisedProfitUsd,
      gasSpentUsd,
    };
  } catch (err) {
    log.error('broadcast failed', { chain: ctx.chain.name, ...errMeta(err) });
    return {
      opportunityId: opportunity.id,
      submitted: false,
      reason: `broadcast failed: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`,
    };
  }
}

/** Pull the exact profit out of the contract's ArbExecuted event. */
function parseRealisedProfit(receipt: TransactionReceipt): bigint | undefined {
  for (const logEntry of receipt.logs) {
    try {
      const parsed = arboIface.parseLog({
        topics: [...logEntry.topics],
        data: logEntry.data,
      });
      if (parsed?.name === 'ArbExecuted') {
        return BigInt(parsed.args[2] as bigint);
      }
    } catch {
      // Not one of ours.
    }
  }
  return undefined;
}

export function describeRoute(opportunity: ArbOpportunity): string {
  const path = [
    opportunity.legs[0]?.tokenIn.symbol ?? '?',
    ...opportunity.legs.map((l) => l.tokenOut.symbol),
  ].join('->');
  const venues = opportunity.legs.map((l) => l.venueId).join('|');
  return `${path} via ${venues}`;
}
