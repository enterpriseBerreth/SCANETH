/**
 * Diagnose why a specific token did (or didn't) trigger a launch alert.
 * Usage: npx tsx scripts/diagnose-token.cjs <tokenAddress>
 */
import { JsonRpcProvider } from 'ethers';
import { readTokenMetadata, analyzeToken } from '../src/scaneth/analyzer';
import { checkSafety } from '../src/scaneth/safety';

const token = process.argv[2];
const pair = process.argv[3];
const dex = process.argv[4] || 'uniswap-v2';

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org', undefined, {
    staticNetwork: true,
    batchMaxCount: 3,
  });

  const meta = await readTokenMetadata(provider, token);
  console.log('metadata:', JSON.stringify(meta, (k, v) => (typeof v === 'bigint' ? String(v) : v)));

  const risk = await analyzeToken(provider, token, '');
  console.log('risk:', JSON.stringify({ score: risk.score, tier: risk.tier, findings: risk.findings.map((f) => `${f.key}(${f.points})`) }));

  const safety = await checkSafety({
    provider,
    tokenAddress: token,
    pairAddress: pair,
    dex,
    probeEth: 0.001,
    maxTaxBps: 1000,
    maxTopHolderPct: 50,
  });
  console.log('safety:', JSON.stringify({
    sellable: safety.sellable,
    buyable: safety.buyable,
    simulationSkipped: safety.simulationSkipped,
    score: safety.score,
    findings: safety.findings.map((f) => `${f.key}(${f.points})`),
  }));

  // Reproduce shouldAlert from both old and new logic.
  const oldGate = meta.complete && (safety.sellable || safety.simulationSkipped)
    && !safety.findings.some((f) => ['paused', 'blacklist_active', 'buy_failed', 'sell_failed', 'max_tx_blocks_sell'].includes(f.key));
  const newGate = meta.complete && (safety.simulationSkipped || safety.sellable);
  console.log('wouldAlert — old filter:', oldGate, '| new filter:', newGate);
}

void main();
