# ARBO

Crypto arbitrage bot. Two independent engines:

- **Engine A — atomic DEX arbitrage, flash-loan funded.** Scans Uniswap V2-fork and Uniswap V3 pools across chains for 2-leg cross-venue and triangular cycles, sizes each one optimally, and executes the whole route inside a single flash loan. Because the trade is atomic and the contract reverts unless it clears a minimum profit, an arb that goes bad costs gas — never principal.
- **Engine B — CEX spread scanner, alert only.** Reads public order books via `ccxt` and reports cross-venue spreads net of taker fees and withdrawal costs.

The two are separate for a reason that is worth stating plainly: **a flash loan cannot span a centralised exchange.** It must be repaid in the same transaction, and no CEX deposit/withdraw settles inside a block. Cross-venue CEX arbitrage requires pre-positioned inventory on both sides, which is a fundamentally different risk model. Engine B therefore scans and alerts; it does not trade.

## Status

Ships in `MODE=simulate`, which scores and logs opportunities and **never sends a transaction**. Going live is a config change, not a rewrite:

1. Deploy the contract — `npm run deploy:contract`
2. Set `ARB_CONTRACT_<CHAIN>` and `EXECUTOR_PRIVATE_KEY`
3. Set `MODE=live`

The config layer refuses to start in `live` mode if either value is missing, so it cannot be half-enabled by accident.

## Quick start

```bash
npm install
copy env.template .env      # then edit
npm run doctor              # validate every address against live RPCs
npm run scan:once           # one full scan pass, then exit
npm start                   # continuous
```

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Run continuously |
| `npm run scan:once` | Single scan pass, then exit cleanly |
| `npm run doctor` | Validate chains, venues, lenders and pool prices against live RPCs |
| `npm test` | Profit-engine verification (19 checks) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run bench:rpc` | Benchmark candidate RPC endpoints |
| `npm run deploy:contract` | Compile and deploy `ArboFlashArb.sol` |

Health endpoints: `/health` (liveness) and `/stats` (full run state, per-chain diagnostics, prices).

## How it decides

**Two-phase scanning**, because RPC calls are the scarce resource:

1. **Screen** — nearly free. V2 pools are priced from cached reserves; V3 pools get one small batched probe quote. Anything whose fee-adjusted spread cannot cover the flash premium is dropped here.
2. **Confirm** — survivors only. V2-only cycles are sized by exact local ternary search at zero RPC cost; cycles touching V3 are sized with a batched on-chain quote ladder.

**Optimal sizing** uses ternary search rather than the closed-form V2 solution, because the closed form does not generalise to V3 or to mixed-venue routes. Profit is computed net of the flash premium, both swap fees, price impact, and gas priced in real USD.

**Gas is priced from live pool reserves, not a constant.** This is deliberate. A hardcoded ETH price of $3000 against a $1865 market is a 60% error in every gas estimate, which silently rejects profitable trades — or, in the other direction, accepts unprofitable ones.

**Balancer V2 is preferred over Aave V3** for the flash loan, because Balancer charges no premium versus Aave's 5 bps. Aave is the fallback.

## Liquidity floor

`MIN_POOL_LIQUIDITY_USD` (default `$25,000`) excludes pools below the floor. This is not a nice-to-have.

Abandoned pools exist at every V3 fee tier for every pair. Because arbitraging them back to fair value costs more gas than they contain, nobody ever does, so they sit at arbitrary prices indefinitely. Left in the scan they are not opportunities but phantoms: a live Base DAI/USDC pool screened at a rate off by a factor of 1e8 — an apparent 99-billion-percent edge — and a WETH/DAI pool sat at 2.2x the true rate. They also consumed the entire quote budget. Excluding them is what makes the reported edge numbers mean anything.

A second guard, `MAX_RATE_DEVIATION` in `src/onchain/scanner.ts`, discards any venue quote more than 3x away from the oracle-implied rate. Real cross-venue edges are basis points, so the band is generous while still rejecting provably-broken data.

## Reading the logs

Every scan reports stage counters, not just a result:

```
scan complete — no actionable opportunities
  v2Pools: 1  v3Pools: 6  durationMs: 918
  cyclesScreened: 2  cyclesConfirmed: 2  cyclesUnprofitable: 2
  quotesImplausible: 0
  bestEdgeBps: 105.45  bestEdgeRoute: "WETH/USDC uniswap-v2->uniswap-v3"
  nativeUsd: 1872.64
```

`bestEdgeBps` is the number to watch — the best fee-adjusted spot edge seen that pass, in bps against break-even. A small or negative value means the code is working and the market is tight. **`null` means nothing was ever priced**, which is a bug in the scanner or the pool set, not market conditions. Without these counters a quiet scan and a broken scan look identical, since both report zero opportunities.

Note that a positive `bestEdgeBps` is not a missed trade. Phase 1 prices at spot, ignoring price impact; phase 2 walks real quotes at real sizes and usually finds the edge evaporates. That gap is the screen doing its job.

## RPC latency

Defaults are benchmarked, not guessed — re-check with `npm run bench:rpc`:

| Endpoint | 6 concurrent bursts x 20 calls |
|---|---|
| `mainnet.base.org` | 2170 ms |
| `base-rpc.publicnode.com` | **263 ms** |
| `1rpc.io/base` | 155 ms |
| `base.llamarpc.com` | fails (521) |

The obvious choice, `mainnet.base.org`, throttles hard enough to turn a Base scan pass into 49 seconds. Switching endpoints alone took it to 3.2s. For `MODE=live`, use a paid endpoint — latency is the difference between winning a fill and paying gas to lose one.

## Safety

- `MODE=simulate` cannot send a transaction. The executor has a hard guard, not just a branch.
- Every send is preceded by a mandatory `eth_call` simulation against pending state.
- `ArboFlashArb.executeArb` is `onlyOwner`, and asserts `finalBalance >= owed + minProfit` on-chain, reverting otherwise. An unprofitable arb costs gas, never principal.
- Risk engine: per-trade cap, daily loss limit, consecutive-failure cooldown, `KILL_SWITCH`.
- `rescueTokens` escape hatch on the contract.

## An honest note on expectations

Atomic DEX-to-DEX arbitrage is one of the most competitive niches in crypto. Professional searchers run co-located infrastructure with private orderflow and submit through builder-integrated relays. The accounting here is rigorous — correct fee and gas math, pre-send simulation, revert-on-unprofitable — so ARBO should not lose principal on a bad fill. That is a different claim from it being profitable.

Run it in `simulate` long enough to see whether the opportunities it detects actually survive real gas and real competition **before** funding the contract. The `bestEdgeBps` figure over time is the honest measure of whether there is anything here worth trading on your chosen chains and pairs.

## Layout

```
contracts/ArboFlashArb.sol     Flash-loan receiver (Aave V3 + Balancer V2)
scripts/deploy-contract.mjs    solc compile + deploy (no Foundry needed)
scripts/bench-rpc.mjs          RPC endpoint benchmark
src/config.ts                  Env parsing + hard validation
src/chains.ts                  Chain registry: RPCs, lenders, venues, tokens
src/onchain/provider.ts        Providers + Multicall3 batching with bisect retry
src/onchain/dex/               V2 and V3 adapters, pool discovery, depth filter
src/onchain/prices.ts          USD oracle derived from live pool reserves
src/onchain/profit.ts          Optimal sizing and full cost accounting
src/onchain/scanner.ts         Two-phase cycle search + diagnostics
src/onchain/executor.ts        Encoding, eth_call simulation, submission
src/cex/                       Public-feed spread scanner
src/risk.ts                    Caps, loss limits, kill switch
src/server.ts                  /health and /stats
src/tools/doctor.ts            Live address and pool validation
```
