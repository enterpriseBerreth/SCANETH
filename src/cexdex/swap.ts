/**
 * Simple single-hop Uniswap V3 swap executor for CEX-DEX arbitrage.
 *
 * Unlike the flash-loan executor, this does not borrow. It directly swaps an
 * ERC20 balance already held in the bot's wallet through the canonical
 * SwapRouter. The router address is read from the chain registry's uniswap-v3
 * venue.
 */
import { Contract, Interface, type TransactionResponse } from 'ethers';
import { UNIV3_QUOTER_V2_ABI } from '../onchain/abi.js';
import type { ChainContext } from '../onchain/provider.js';
import type { TokenInfo } from '../types.js';
import { createLogger, errMeta } from '../logger.js';

const log = createLogger('cexdex-swap');

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
];

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export interface DexSwapResult {
  txHash: string;
  amountOut: bigint;
  gasUsed: bigint;
}

/**
 * Execute an exact-input single-hop V3 swap. If the wallet has not approved the
 * router, an approve tx is sent first. Both transactions are logged and any
 * failure is returned as undefined rather than thrown into the caller.
 */
export async function executeDexSwap(
  ctx: ChainContext,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  feeTier: number,
  amountIn: bigint,
  slippageBps: number,
): Promise<DexSwapResult | undefined> {
  const wallet = ctx.wallet;
  if (!wallet) {
    log.error('no wallet available for DEX swap');
    return undefined;
  }

  const venue = ctx.chain.venues.find((v) => v.id === 'uniswap-v3');
  const routerAddress = venue?.router;
  if (!routerAddress || routerAddress === '0x0000000000000000000000000000000000000000') {
    log.error('no uniswap-v3 router configured for chain', { chain: ctx.chain.name });
    return undefined;
  }

  // 1. Quote the swap to set minOut.
  const quoterAddress = venue?.quoter;
  if (!quoterAddress) {
    log.error('no uniswap-v3 quoter configured for chain', { chain: ctx.chain.name });
    return undefined;
  }
  const quoter = new Contract(quoterAddress, UNIV3_QUOTER_V2_ABI, ctx.provider);
  let expectedOut: bigint;
  try {
    const q = quoter.getFunction('quoteExactInputSingle');
    const result = (await q.staticCall([
      tokenIn.address,
      tokenOut.address,
      amountIn,
      feeTier,
      0n,
    ])) as [bigint, bigint, number, bigint];
    expectedOut = result[0];
  } catch (err) {
    log.warn('dex swap pre-quote failed', { chain: ctx.chain.name, ...errMeta(err) });
    return undefined;
  }

  const minOut = (expectedOut * BigInt(10_000 - Math.max(0, Math.min(10_000, slippageBps)))) / 10_000n;

  // 2. Approve router if needed.
  const tokenContract = new Contract(tokenIn.address, ERC20_APPROVE_ABI, wallet);
  try {
    const allowanceFn = tokenContract.getFunction('allowance');
    const allowance = (await allowanceFn(wallet.address, routerAddress)) as bigint;
    if (allowance < amountIn) {
      log.info('approving router for token', {
        chain: ctx.chain.name,
        token: tokenIn.symbol,
        router: routerAddress,
      });
      const approveFn = tokenContract.getFunction('approve');
      const approveTx = (await approveFn(routerAddress, amountIn)) as TransactionResponse;
      await approveTx.wait(1);
    }
  } catch (err) {
    log.warn('token approval failed', { chain: ctx.chain.name, ...errMeta(err) });
    return undefined;
  }

  // 3. Build and send swap.
  const router = new Contract(routerAddress, SWAP_ROUTER_ABI, wallet);
  try {
    const deadline = Math.floor(Date.now() / 1000) + 60; // 60s deadline
    const iface = new Interface(SWAP_ROUTER_ABI);
    const swapCalldata = iface.encodeFunctionData('exactInputSingle', [
      {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: feeTier,
        recipient: wallet.address,
        deadline,
        amountIn,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    const deadlineCalldata = iface.encodeFunctionData('multicall', [[swapCalldata]]);
    const feeData = await ctx.provider.getFeeData();
    const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    const gasLimit = 250_000n;
    const multicallFn = router.getFunction('multicall');
    const tx = (await multicallFn(deadlineCalldata, { gasPrice: gasPriceWei, gasLimit })) as TransactionResponse;
    const receipt = await tx.wait(1);
    if (!receipt) {
      log.warn('dex swap receipt not available', { txHash: tx.hash });
      return undefined;
    }
    return {
      txHash: tx.hash,
      amountOut: minOut, // Conservative; real amountOut is at least this.
      gasUsed: receipt.gasUsed,
    };
  } catch (err) {
    log.warn('dex swap failed', { chain: ctx.chain.name, ...errMeta(err) });
    return undefined;
  }
}
