/**
 * RPC plumbing: providers, Multicall3 batching, gas pricing.
 *
 * Reads go through the normal RPC. Writes optionally go through a separate
 * private/MEV-protected endpoint, because broadcasting an arbitrage transaction
 * to the public mempool is an invitation to be front-run out of the profit.
 */

import { Contract, JsonRpcProvider, Network, Wallet, type Provider } from 'ethers';
import { MULTICALL3_ABI } from './abi';
import type { ArboConfig } from '../config';
import type { ChainConfig } from '../types';
import { createLogger, errMeta } from '../logger';

const log = createLogger('provider');

export interface ChainContext {
  chain: ChainConfig;
  /** Used for all reads. */
  provider: JsonRpcProvider;
  /** Used only for broadcasting. Falls back to `provider`. */
  submitProvider: JsonRpcProvider;
  /** Present only when an executor key is configured. */
  wallet?: Wallet;
  /** Deployed ArboFlashArb address, when available. */
  contractAddress?: string;
  multicall: Contract;
  /**
   * Pins every batched read to a historical block.
   *
   * Set only by the backtester. Because all quoting funnels through `multicall`,
   * this one field makes an entire scan replay against past state — the same
   * code path, the same adapters, the same profit math, just answered by the
   * chain as it was. Nothing in the live path sets it.
   */
  blockTag?: number;
}

export function createChainContext(config: ArboConfig, chain: ChainConfig): ChainContext {
  const network = Network.from(chain.chainId);

  const provider = new JsonRpcProvider(config.rpcUrls[chain.name], network, {
    staticNetwork: network,
    batchMaxCount: 12,
  });

  const submitProvider = config.privateSubmitRpcUrl
    ? new JsonRpcProvider(config.privateSubmitRpcUrl, network, { staticNetwork: network })
    : provider;

  const wallet = config.executorPrivateKey
    ? new Wallet(config.executorPrivateKey, submitProvider)
    : undefined;

  return {
    chain,
    provider,
    submitProvider,
    wallet,
    contractAddress: config.contractAddresses[chain.name],
    multicall: new Contract(chain.multicall3, MULTICALL3_ABI, provider),
  };
}

export interface Call {
  target: string;
  callData: string;
  allowFailure?: boolean;
}

export interface CallResult {
  success: boolean;
  returnData: string;
}

/**
 * Batch many eth_calls into one via Multicall3.
 *
 * Chunked because QuoterV2 calls are gas-hungry and a large batch can exceed the
 * node's eth_call gas ceiling. When a whole chunk fails — which public RPCs do
 * under load, reporting an unhelpful "missing revert data" — the chunk is split
 * in half and retried rather than written off. One oversized batch therefore
 * degrades into a few smaller successful ones instead of blinding the scanner.
 *
 * Per-call failures (allowFailure) are normal and expected: a pool with no
 * liquidity at the requested size simply reverts.
 */
export async function multicall(
  ctx: ChainContext,
  calls: Call[],
  chunkSize = 25,
): Promise<CallResult[]> {
  if (calls.length === 0) return [];

  const results: CallResult[] = [];
  for (let i = 0; i < calls.length; i += chunkSize) {
    const chunk = calls.slice(i, i + chunkSize);
    results.push(...(await executeChunk(ctx, chunk, 0)));
  }
  return results;
}

/** Minimum chunk size below which we stop bisecting and accept failure. */
const MIN_BISECT_SIZE = 1;
const MAX_BISECT_DEPTH = 5;

async function executeChunk(
  ctx: ChainContext,
  chunk: Call[],
  depth: number,
): Promise<CallResult[]> {
  if (chunk.length === 0) return [];

  const payload = chunk.map((c) => ({
    target: c.target,
    allowFailure: c.allowFailure ?? true,
    callData: c.callData,
  }));

  try {
    const aggregate3 = ctx.multicall.getFunction('aggregate3');
    const raw = (await aggregate3.staticCall(
      payload,
      ctx.blockTag === undefined ? {} : { blockTag: ctx.blockTag },
    )) as Array<[boolean, string] | { success: boolean; returnData: string }>;

    const decoded: CallResult[] = [];
    for (const entry of raw) {
      if (Array.isArray(entry)) {
        decoded.push({ success: entry[0], returnData: entry[1] });
      } else {
        decoded.push({ success: entry.success, returnData: entry.returnData });
      }
    }
    return decoded;
  } catch (err) {
    // Split and retry: usually an eth_call gas ceiling, occasionally RPC load.
    if (chunk.length > MIN_BISECT_SIZE && depth < MAX_BISECT_DEPTH) {
      const middle = Math.ceil(chunk.length / 2);
      log.debug('multicall chunk failed, bisecting', {
        chain: ctx.chain.name,
        size: chunk.length,
        depth,
      });
      const [left, right] = await Promise.all([
        executeChunk(ctx, chunk.slice(0, middle), depth + 1),
        executeChunk(ctx, chunk.slice(middle), depth + 1),
      ]);
      return [...left, ...right];
    }

    log.debug('multicall call failed after bisecting', {
      chain: ctx.chain.name,
      ...errMeta(err),
    });
    // Record misses so indices stay aligned with the request list.
    return chunk.map(() => ({ success: false, returnData: '0x' }));
  }
}

/** Current gas price in wei, preferring EIP-1559 fields where available. */
export async function getGasPriceWei(provider: Provider): Promise<bigint> {
  const feeData = await provider.getFeeData();
  return feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function isZeroAddress(address: string): boolean {
  return !address || address.toLowerCase() === ZERO_ADDRESS;
}
