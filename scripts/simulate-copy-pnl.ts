/**
 * Simulate paper-copytrading specific wallets over the past N days with the
 * real SCANETH rules ($1000 start, $20/buy, proportional exit on the wallet's
 * sell, no concurrent limit). Reconstructs the trade timeline from on-chain
 * history (Blockscout receipts) and marks unsold positions at current prices.
 *
 * Usage: npx tsx scripts/simulate-copy-pnl.ts <days=4>
 */
import { Contract, JsonRpcProvider } from 'ethers';

const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WETH_WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const APPROVE_SELECTOR = '0x095ea7b3';
const MIN_TX_VALUE_ETH = 0.005;
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const START_CASH = 1000;
const BUY_USD = 20;

const WALLETS = [
  '0x2d3d805517ae175153a3166b915b6ae9d32f509a',
  '0x82e159d63e585067e9fa3a4bba7d992fbc667751',
  '0x9748566962e3f6caac751d860614889794c2f098',
  '0xb51ff2f65b935142aab32abefa1c0e29a4161d31',
  '0xc05ef5e1fd014267f66fa24b260f361af7d79122',
  '0xae3c9dfd4dd4700d2382e985fb348b71b1341b5d',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getReceiptWithRetry(provider: JsonRpcProvider, hash: string): Promise<Awaited<ReturnType<JsonRpcProvider['getTransactionReceipt']>>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await provider.getTransactionReceipt(hash);
    } catch (err) {
      if (attempt === 3) {
        process.stderr.write(`receipt failed, skipping tx ${hash}: ${(err as Error).message.slice(0, 100)}\n`);
        return null;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  return null;
}

interface RawTrade {
  ts: number;
  wallet: string;
  type: 'buy' | 'sell';
  token: string;
  tokenRaw: bigint;
  ethAmount: number;
}

interface OpenPos {
  balance: number; // token units
  costBasis: number; // usd
  avgEntry: number; // usd per unit
}

async function fetchEthUsd(provider: JsonRpcProvider): Promise<number> {
  const feed = new Contract(CHAINLINK_ETH_USD, ['function latestAnswer() view returns (int256)'], provider);
  const answer = await (feed.latestAnswer as () => Promise<bigint>)();
  return Number(answer) / 1e8;
}

async function dexPrice(token: string): Promise<{ price: number; symbol: string }> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!r.ok) return { price: 0, symbol: '?' };
    const j = (await r.json()) as { pairs?: { chainId: string; priceUsd?: string; liquidity?: { usd?: number }; baseToken?: { symbol?: string; address?: string } }[] };
    // Only pairs where OUR token is the base — otherwise priceUsd belongs to
    // the other side of the pair and the mark is garbage.
    const pairs = (j.pairs ?? []).filter(
      (p) => p.chainId === 'ethereum' && p.priceUsd && (p.baseToken?.address ?? '').toLowerCase() === token.toLowerCase(),
    );
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return pairs.length
      ? { price: Number(pairs[0].priceUsd), symbol: pairs[0].baseToken?.symbol ?? '?' }
      : { price: 0, symbol: '?' };
  } catch {
    return { price: 0, symbol: '?' };
  }
}

async function collectTrades(provider: JsonRpcProvider, cutoffSec: number, ethUsd: number): Promise<RawTrade[]> {
  const trades: RawTrade[] = [];

  for (const wallet of WALLETS) {
    const wl = wallet.toLowerCase();
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
        if (ts < cutoffSec) { url = null; break; }
        if (checked >= 150) break;
        if ((tx.from?.hash ?? '').toLowerCase() !== wl) continue;
        if ((tx.method ?? '') === 'approve' || (tx.raw_input ?? '').startsWith(APPROVE_SELECTOR)) continue;
        const valueEth = Number(BigInt(tx.value ?? '0')) / 1e18;
        checked++;

        const receipt = await getReceiptWithRetry(provider, tx.hash);
        if (!receipt || receipt.status !== 1) continue;
        await sleep(80);

        const tokensOut = new Map<string, bigint>();
        const tokensIn = new Map<string, bigint>();
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
          let raw = 0n;
          try {
            raw = BigInt(lg.data);
          } catch {
            continue; // malformed transfer log
          }
          if (token === WETH) {
            if (to === wl) wethToWallet += raw;
            else if (from === wl) wethFromWallet += raw;
            continue;
          }
          if (to === wl) tokensIn.set(token, (tokensIn.get(token) ?? 0n) + raw);
          else if (from === wl) tokensOut.set(token, (tokensOut.get(token) ?? 0n) + raw);
        }

        const ethIn = Number(wethToWallet) / 1e18 + Number(unwrapped) / 1e18;
        const ethOut = valueEth + Number(wethFromWallet) / 1e18;

        for (const [token, raw] of tokensIn) {
          if (tokensOut.has(token)) continue;
          if (ethOut < MIN_TX_VALUE_ETH) continue;
          trades.push({ ts, wallet, type: 'buy', token, tokenRaw: raw, ethAmount: ethOut });
        }
        for (const [token, raw] of tokensOut) {
          if (tokensIn.has(token)) continue;
          if (ethIn < MIN_TX_VALUE_ETH) continue;
          trades.push({ ts, wallet, type: 'sell', token, tokenRaw: raw, ethAmount: ethIn });
        }
      }

      if (url) {
        url = j.next_page_params
          ? `${BLOCKSCOUT}/addresses/${wl}/transactions?${new URLSearchParams(Object.fromEntries(Object.entries(j.next_page_params as Record<string, unknown>).map(([k, v]) => [k, String(v)]))).toString()}`
          : null;
      }
      await sleep(120);
    }
    process.stderr.write(`collected ${wallet}: ${checked} txs\n`);
  }

  trades.sort((a, b) => a.ts - b.ts);
  void ethUsd;
  return trades;
}

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? '4');
  const cutoffSec = Math.floor(Date.now() / 1000) - days * 86400;
  const provider = new JsonRpcProvider(process.env.ETHEREUM_RPC_URL || 'https://eth.drpc.org', undefined, {
    staticNetwork: true,
    batchMaxCount: 3,
  });

  const ethUsd = await fetchEthUsd(provider);
  console.log(`Simulating copy of ${WALLETS.length} wallets over past ${days} days | ETH/USD now: $${ethUsd.toFixed(2)}\n`);

  const trades = await collectTrades(provider, cutoffSec, ethUsd);
  process.stderr.write(`total raw trades: ${trades.length}\n`);

  // Paper account state.
  let cash = START_CASH;
  const positions = new Map<string, OpenPos>();
  // (wallet, token) -> raw balance, for proportional sell sizing.
  const walletHeld = new Map<string, bigint>();
  let buysCopied = 0;
  let sellsCopied = 0;
  let skippedNoCash = 0;
  let realizedPnl = 0;

  for (const t of trades) {
    const heldKey = `${t.wallet}:${t.token}`;
    const pricePerUnit = (t.ethAmount * ethUsd) / (Number(t.tokenRaw) / 1e18); // usd per full token unit (1e18 scale)

    if (t.type === 'buy') {
      // Track wallet's raw holding for proportional exits.
      walletHeld.set(heldKey, (walletHeld.get(heldKey) ?? 0n) + t.tokenRaw);

      if (cash < BUY_USD) { skippedNoCash++; continue; }
      cash -= BUY_USD;
      buysCopied++;

      const pos = positions.get(t.token) ?? { balance: 0, costBasis: 0, avgEntry: 0 };
      const qty = BUY_USD / pricePerUnit;
      const newCost = pos.costBasis + BUY_USD;
      const newBal = pos.balance + qty;
      pos.avgEntry = newCost / newBal;
      pos.costBasis = newCost;
      pos.balance = newBal;
      positions.set(t.token, pos);
    } else {
      const heldBefore = walletHeld.get(heldKey) ?? 0n;
      walletHeld.set(heldKey, heldBefore > t.tokenRaw ? heldBefore - t.tokenRaw : 0n);

      const pos = positions.get(t.token);
      if (!pos || pos.balance <= 0) continue;
      sellsCopied++;

      const sellPct = heldBefore > 0n ? Math.min(1, Number(t.tokenRaw) / Number(heldBefore)) : 1;
      const qtySold = pos.balance * sellPct;
      const proceeds = qtySold * pricePerUnit;
      const costSold = qtySold * pos.avgEntry;
      realizedPnl += proceeds - costSold;
      cash += proceeds;
      pos.balance -= qtySold;
      pos.costBasis = Math.max(0, pos.costBasis - costSold);
      if (pos.balance <= 1e-12) positions.delete(t.token);
    }
  }

  // Mark remaining open positions at current market prices.
  // Positions are tracked in internal "1e18 raw units" scale. To convert to
  // real units we need the token's decimals: derive the scale that makes the
  // current DEX price consistent with the position's own avg entry price
  // (immune to broken/missing decimals() — the entry price is the anchor).
  let openValue = 0;
  const openDetail: string[] = [];
  for (const [token, pos] of positions) {
    const { price: px, symbol } = await dexPrice(token);
    let value: number;
    if (px > 0 && pos.avgEntry > 0) {
      // price per internal unit at scale d = px * 1e18 / 10^d.
      // Pick d minimizing deviation from avgEntry, then value the position.
      let bestD = 18;
      let bestOff = Infinity;
      for (let cand = 0; cand <= 18; cand++) {
        const pricePerUnit = (px * 1e18) / Math.pow(10, cand);
        if (!(pricePerUnit > 0)) continue;
        const off = Math.abs(Math.log10(pricePerUnit / pos.avgEntry));
        if (off < bestOff) { bestOff = off; bestD = cand; }
      }
      value = (pos.balance * 1e18 / Math.pow(10, bestD)) * px;
    } else {
      // No live pair — token is likely dead: mark at zero.
      value = 0;
    }
    openValue += value;
    openDetail.push(`${symbol} ${token} cost $${pos.costBasis.toFixed(2)} -> value $${value.toFixed(2)}`);
    await sleep(250);
  }

  const equity = cash + openValue;
  const pnl = equity - START_CASH;

  console.log(`Trades copied: ${buysCopied} buys, ${sellsCopied} sells (skipped ${skippedNoCash} buys — out of cash)`);
  console.log(`Realized PNL (closed exits): ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`);
  console.log(`Open positions: ${positions.size}, marked value: $${openValue.toFixed(2)}`);
  if (openDetail.length) console.log(openDetail.join('\n'));
  console.log(`\nFINAL EQUITY: $${equity.toFixed(2)}`);
  console.log(`TOTAL PNL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${((pnl / START_CASH) * 100).toFixed(2)}%)`);
}

void main();
