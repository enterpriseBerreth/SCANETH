/**
 * Check whether the V2 round-trip simulation works against an established,
 * known-good token (should return sellable=true, simulationSkipped=false).
 * Usage: npx tsx scripts/check-sim-health.ts
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
  const provider = new JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org');
  const router = new Contract(ROUTER, UNIV2_ROUTER_ABI, provider);

  // USDC/WETH — the most liquid pair on Ethereum.
  const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const probeWei = BigInt(Math.floor(0.001 * 1e18));
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const buyer = '0x0000000000000000000000000000000000000001';

  try {
    const amounts = (await router.getAmountsOut(probeWei, [WETH, token])) as bigint[];
    const tokenOut = amounts[amounts.length - 1];
    console.log('buy quote ok, tokenOut:', tokenOut.toString());

    try {
      await (router.swapExactETHForTokens as unknown as { staticCall: (a: bigint, p: string[], t: string, d: number, o: object) => Promise<unknown> }).staticCall(
        0, [WETH, token], buyer, deadline, { value: probeWei },
      );
      console.log('buy staticCall ok');
    } catch (err) {
      console.log('buy staticCall REVERTED:', (err as Error).message.slice(0, 200));
    }

    try {
      await (router.swapExactTokensForETH as unknown as { staticCall: (a: bigint, m: bigint, p: string[], t: string, d: number, o?: object) => Promise<unknown> }).staticCall(
        tokenOut, 0, [token, WETH], buyer, deadline,
      );
      console.log('sell staticCall ok');
    } catch (err) {
      console.log('sell staticCall REVERTED:', (err as Error).message.slice(0, 200));
    }
  } catch (err) {
    console.log('quote FAILED:', (err as Error).message.slice(0, 300));
  }
}

void main();
