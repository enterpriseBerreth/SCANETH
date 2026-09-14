/**
 * Test the sell-transfer probe (token.transfer staticCall from the pair) for
 * a token at this moment. Usage: npx tsx scripts/test-sell-probe.ts <token> <pair>
 */
import { Contract, JsonRpcProvider } from 'ethers';

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

async function main(): Promise<void> {
  const token = process.argv[2];
  const pair = process.argv[3];
  const provider = new JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org', undefined, {
    staticNetwork: true,
    batchMaxCount: 3,
  });

  const c = new Contract(token, ERC20_TRANSFER_ABI, provider);
  const buyer = '0x0000000000000000000000000000000000000001';

  // Try a few amounts: 1e18 raw, 1e15 raw.
  for (const amount of [10n ** 18n, 10n ** 15n]) {
    try {
      await (c.transfer as unknown as {
        staticCall: (to: string, amount: bigint, o: { from: string }) => Promise<boolean>;
      }).staticCall(buyer, amount, { from: pair });
      console.log(`transfer ${amount} raw from pair: OK (sellable)`);
    } catch (err) {
      console.log(`transfer ${amount} raw from pair: REVERT — ${(err as Error).message.slice(0, 180)}`);
    }
  }
}

void main();
