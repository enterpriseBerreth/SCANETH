/**
 * Reconstruct per-wallet round-trip PNL for the watched copytrade wallets
 * over the past N days directly from on-chain history (Blockscout + RPC).
 *
 * Usage: npx tsx scripts/wallet-pnl-history.ts [days=4]
 */
import { Contract, JsonRpcProvider } from 'ethers';

const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const APPROVE_SELECTOR = '0x095ea7b3';
const MIN_TX_VALUE_ETH = 0.005;
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';

const WALLETS = [
  '0x2d3d805517ae175153a3166b915b6ae9d32f509a',
  '0xfb8834ddbe592b152be3fb15a6324af95192a00c',
  '0x82e159d63e585067e9fa3a4bba7d992fbc667751',
  '0xa667a51bdcb32dabc8a9396a4523b5fef314ebe7',
  '0x9dbfded199ee3a6b291c223e65f97d387156aada',
  '0xae3c9dfd4dd4700d2382e985fb348b71b1341b5d',
  '0xc05ef5e1fd014267f66fa24b260f361af7d79122',
  '0x9748566962e3f6caac751d860614889794c2f098',
  '0xb51ff2f65b935142aab32abefa1c0e29a4161d31',
  '0xdfb6c7adb4d4e383e2d06a9f745513acb8e7358e',
  '0xe353c12bb28dd8e3d98f63ffe8118154d26d46a7',
  '0x6318eb6235afdc7b4eea60afcce4961873f1c0f7',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WalletResult {
  wallet: string;
  spentEth: number;
  receivedEth: number;
  pnlEth: number;
  pnlPct: number;
  roundTrips: number;
  buys: number;
  sells: number;
  openTokens: number;
}

async function fetchEthUsd(provider: JsonRpcProvider): Promise<number> {
  const feed = new Contract(CHAINLINK_ETH_USD, ['function latestAnswer() view returns (int256)'], provider);
  const answer = await (feed.latestAnswer as () => Promise<bigint>)();
  return Number(answer) / 1e8;
}

async function evaluateWallet(
  provider: JsonRpcProvider,
  wallet: string,
  cutoffSec: number,
): Promise<WalletResult> {
  const wl = wallet.toLowerCase();
  const ethSpent = new Map<string, number>();
  const ethReceived = new Map<string, number>();
  let buys = 0;
  let sells = 0;
  const openTokens = new Set<string>();
  const closedTokens = new Set<string>();

  let url: string | null = `${BLOCKSCOUT}/addresses/${wl}/transactions`;
  let checked = 0;

  while (url && checked < 150) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) break;
    const j = (await r.json()) as {
      items?: { hash: string; timestamp: string; from?: { hash?: string }; method?: string; raw_input?: string; value?: string }[];
      next_page_params?: unknown;
    };
    const items = j.items ?? [];

    for (const tx of items) {
      const ts = Math.floor(new Date(tx.timestamp).getTime() / 1000);
      if (ts < cutoffSec) {
        url = null;
        break;
      }
      if (checked >= 150) break;
      if ((tx.from?.hash ?? '').toLowerCase() !== wl) continue;
      if ((tx.method ?? '') === 'approve' || (tx.raw_input ?? '').startsWith(APPROVE_SELECTOR)) continue;
      const valueEth = Number(BigInt(tx.value ?? '0')) / 1e18;
      checked++;

      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt || receipt.status !== 1) continue;

      const tokensOut = new Set<string>();
      const tokensIn = new Set<string>();
      const ethOut = valueEth;
      let wethToWallet = 0n;
      let wethFromWallet = 0n;
      let unwrapped = 0n;

      for (const lg of receipt.logs) {
        const topic0 = lg.topics[0];
        if (lg.topics.length < 3 || topic0 !== TRANSFER_TOPIC) {
          if (lg.address.toLowerCase() === WETH && topic0 === WETH_WITHDRAWAL_TOPIC) {
            try { unwrapped += BigInt(lg.data); } catch { /* ignore */ }
          }
          continue;
        }
        const t1 = lg.topics[1];
        const t2 = lg.topics[2];
        if (!t1 || !t2) continue;
        const from = '0x' + t1.slice(26).toLowerCase();
        const to = '0x' + t2.slice(26).toLowerCase();
        const token = lg.address.toLowerCase();
        if (token === WETH) {
          if (to === wl) wethToWallet += BigInt(lg.data);
          else if (from === wl) wethFromWallet += BigInt(lg.data);
          continue;
        }
        if (to === wl) tokensIn.add(token);
        else if (from === wl) tokensOut.add(token);
      }

      for (const token of tokensIn) {
        if (tokensOut.has(token)) continue;
        const paid = ethOut + Number(wethFromWallet) / 1e18;
        if (paid >= MIN_TX_VALUE_ETH) {
          ethSpent.set(token, (ethSpent.get(token) ?? 0) + paid);
          buys++;
          openTokens.add(token);
        }
      }
      for (const token of tokensOut) {
        if (tokensIn.has(token)) continue;
        const got = Number(wethToWallet) / 1e18 + Number(unwrapped) / 1e18;
        if (got >= MIN_TX_VALUE_ETH) {
          ethReceived.set(token, (ethReceived.get(token) ?? 0) + got);
          sells++;
          openTokens.delete(token);
          closedTokens.add(token);
        }
      }
    }

    if (url) {
      url = j.next_page_params
        ? `${BLOCKSCOUT}/addresses/${wl}/transactions?${new URLSearchParams(serializePageParams(j.next_page_params)).toString()}`
        : null;
    }
    await sleep(120);
  }

  let totalSpent = 0;
  let totalReceived = 0;
  let roundTrips = 0;
  for (const [token, spent] of ethSpent) {
    const received = ethReceived.get(token);
    if (received === undefined || spent <= 0) continue;
    totalSpent += spent;
    totalReceived += received;
    roundTrips++;
    openTokens.delete(token);
  }

  const pnlEth = totalReceived - totalSpent;
  return {
    wallet,
    spentEth: totalSpent,
    receivedEth: totalReceived,
    pnlEth,
    pnlPct: totalSpent > 0 ? (pnlEth / totalSpent) * 100 : 0,
    roundTrips,
    buys,
    sells,
    openTokens: openTokens.size,
  };
}

function serializePageParams(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      out[k] = String(v);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? '4');
  const cutoffSec = Math.floor(Date.now() / 1000) - days * 86400;
  const provider = new JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org', undefined, {
    staticNetwork: true,
    batchMaxCount: 3,
  });

  const ethUsd = await fetchEthUsd(provider);
  console.log(`Window: past ${days} days | ETH/USD: $${ethUsd.toFixed(2)}\n`);

  const results: WalletResult[] = [];
  for (const w of WALLETS) {
    process.stderr.write(`evaluating ${w}...\n`);
    const res = await evaluateWallet(provider, w, cutoffSec);
    results.push(res);
    await sleep(300);
  }

  results.sort((a, b) => b.pnlEth - a.pnlEth);
  console.log('RANK | WALLET | PNL ETH | PNL USD | PNL % | ROUND TRIPS | BUYS/SELLS | OPEN TOKENS');
  results.forEach((r, i) => {
    const short = `${r.wallet.slice(0, 8)}...${r.wallet.slice(-4)}`;
    console.log(
      `${i + 1}. ${short} | ${r.pnlEth >= 0 ? '+' : ''}${r.pnlEth.toFixed(3)} ETH | ` +
      `${r.pnlEth >= 0 ? '+' : ''}$${(r.pnlEth * ethUsd).toFixed(2)} | ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}% | ` +
      `${r.roundTrips} | ${r.buys}/${r.sells} | ${r.openTokens}`,
    );
  });
}

void main();
