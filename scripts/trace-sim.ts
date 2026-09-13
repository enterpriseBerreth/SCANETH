/**
 * Step-by-step trace of the V2 round-trip simulation for one token.
 * Usage: npx tsx scripts/trace-sim.ts <tokenAddress>
 */
import { Contract, JsonRpcProvider } from 'ethers';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const UNIV2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
];

async function main(): Promise<void> {
  const token = process.argv[2];
  const provider = new JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org');
  const router = new Contract(ROUTER, UNIV2_ROUTER_ABI, provider);
  const probeWei = BigInt(Math.floor(0.001 * 1e18));
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const buyer = '0x0000000000000000000000000000000000000001';

  try {
    const buyAmounts = (await router.getAmountsOut(probeWei, [WETH, token])) as bigint[];
    const tokenOut = buyAmounts[buyAmounts.length - 1] ?? 0n;
    console.log('1. buy quote ok, tokenOut:', tokenOut.toString());
    if (tokenOut <= 0n) {
      console.log('   -> tokenOut is zero');
      return;
    }

    try {
      await (router.swapExactETHForTokens as unknown as { staticCall: (...a: unknown[]) => Promise<unknown> }).staticCall(
        0, [WETH, token], buyer, deadline, { value: probeWei },
      );
      console.log('2. buy staticCall ok');
    } catch (err) {
      console.log('2. buy staticCall reverted:', (err as Error).message.slice(0, 120));
    }

    try {
      const sellAmounts = (await router.getAmountsOut(tokenOut, [token, WETH])) as bigint[];
      const ethBack = sellAmounts[sellAmounts.length - 1] ?? 0n;
      console.log('3. sell quote ok, ethBack:', ethBack.toString());

      try {
        await (router.swapExactTokensForETH as unknown as { staticCall: (...a: unknown[]) => Promise<unknown> }).staticCall(
          tokenOut, 0, [token, WETH], buyer, deadline,
        );
        console.log('4. sell staticCall ok — SELLABLE');
      } catch (err) {
        console.log('4. sell staticCall reverted:', (err as Error).message.slice(0, 160));
      }
    } catch (err) {
      console.log('3. sell quote FAILED:', (err as Error).message.slice(0, 200));
    }
  } catch (err) {
    console.log('1. buy quote FAILED:', (err as Error).message.slice(0, 200));
  }
}

void main();
