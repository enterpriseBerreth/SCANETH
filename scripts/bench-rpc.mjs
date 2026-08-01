/**
 * Benchmark candidate RPC endpoints for a chain.
 *
 * Measures what the scanner actually does — a burst of concurrent eth_calls
 * through Multicall3 — rather than a single ping, because throttling only shows
 * up under concurrency.
 *
 * Usage: node scripts/bench-rpc.mjs
 */

import { JsonRpcProvider, Network, Contract } from 'ethers';

const CANDIDATES = {
  base: [
    'https://mainnet.base.org',
    'https://base.llamarpc.com',
    'https://base-rpc.publicnode.com',
    'https://base.drpc.org',
    'https://1rpc.io/base',
  ],
  arbitrum: [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum.llamarpc.com',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.drpc.org',
  ],
};

const CHAIN_IDS = { base: 8453, arbitrum: 42161 };
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
];

// getReserves() on a real pool — cheap, but a genuine eth_call.
const GET_RESERVES = '0x0902f1ac';
const POOLS = {
  base: '0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C', // uni-v2 WETH/USDC
  arbitrum: '0x905dfCD5649217c42684f23958568e533C711Aa3', // sushi WETH/USDC
};

const BURSTS = 6;
const CALLS_PER_BURST = 20;

async function bench(chain, url) {
  const network = new Network(chain, CHAIN_IDS[chain]);
  const provider = new JsonRpcProvider(url, network, {
    staticNetwork: network,
    batchMaxCount: 1,
  });

  try {
    const multicall = new Contract(MULTICALL3, ABI, provider);
    const payload = Array.from({ length: CALLS_PER_BURST }, () => ({
      target: POOLS[chain],
      allowFailure: true,
      callData: GET_RESERVES,
    }));

    // Warm the connection so TLS handshake isn't counted.
    await provider.getBlockNumber();

    const started = Date.now();
    // Concurrent bursts are the realistic pattern and the one that trips limits.
    await Promise.all(
      Array.from({ length: BURSTS }, () =>
        multicall.getFunction('aggregate3').staticCall(payload),
      ),
    );
    const elapsed = Date.now() - started;

    return { url, ok: true, ms: elapsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, ok: false, error: msg.slice(0, 90) };
  } finally {
    provider.destroy();
  }
}

for (const [chain, urls] of Object.entries(CANDIDATES)) {
  console.log(`\n=== ${chain} (${BURSTS} concurrent bursts x ${CALLS_PER_BURST} calls) ===`);
  const results = [];
  for (const url of urls) {
    const r = await bench(chain, url);
    results.push(r);
    console.log(
      r.ok
        ? `  ${String(r.ms).padStart(6)} ms  ${r.url}`
        : `     FAIL  ${r.url}  (${r.error})`,
    );
  }
  const best = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)[0];
  if (best) console.log(`  -> fastest: ${best.url} (${best.ms} ms)`);
}
