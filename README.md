# SCANETH

**SCANETH** = Smart Contract Analyzer for New Ethereum Tokens.

A research-only Ethereum mainnet bot that watches every block for newly created ERC-20 contracts, pairs them with nearby Uniswap V2/V3 and SushiSwap V2 liquidity events, runs a static risk analysis on their bytecode and metadata, and sends Telegram alerts for low-risk launches.

No transactions are sent. No private keys are required. SCANETH is an alpha-generation and risk-screening tool, not a trading bot.

## What it does

1. **Block streaming** — connects via WebSocket when available, or HTTP polling as a fallback.
2. **Contract creation detection** — every block is inspected for new contracts.
3. **DEX liquidity pairing** — `PairCreated` and `PoolCreated` events are matched to token contracts within a 3-block window.
4. **Risk scoring** — bytecode heuristics + metadata completeness produce a 0-100 score:
   - red-flag opcodes (selfdestruct, blacklist, unguarded mint, pause, etc.)
   - missing ERC-20 compliance signals
   - incomplete name/symbol/decimals/totalSupply
   - tiny or zero supply
   - EOA deployer vs. launchpad contract
5. **Telegram alerts** — only launches that cleared the risk threshold, received real liquidity, and have complete metadata are pushed.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ETHEREUM_RPC_URL` | no | `https://ethereum-rpc.publicnode.com` | HTTP RPC endpoint |
| `ETHEREUM_WS_URL` | no | — | WebSocket RPC endpoint (strongly recommended) |
| `PORT` | no | `3000` | HTTP server port |
| `ALERT_RISK_SCORE` | no | `25` | Max risk score (0-100) to alert |
| `POLL_INTERVAL_MS` | no | `12000` | HTTP polling cadence when no WS |
| `START_BLOCK` | no | current head | Override first block to scan |
| `BACKTEST_FROM` / `BACKTEST_TO` | no | — | Scan a historical range and exit |
| `TELEGRAM_BOT_TOKEN` | no | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | no | — | Telegram chat/channel id |
| `TELEGRAM_TEST_ON_BOOT` | no | `false` | Send a test alert at startup |
| `SCANETH_ENABLED` | no | `true` | Set `false` to disable scanning |

## Quick start

```bash
npm install
copy env.template .env   # then edit
npm run typecheck
npm start
```

## HTTP endpoints

- `GET /health` — liveness, returns scanner state and block counters.
- `GET /stats` — full run state, recent alerts, config summary.
- `GET /alerts` — last 20 alert payloads.

## Backtesting

```bash
set BACKTEST_FROM=21000000
set BACKTEST_TO=21000010
npm start
```

The bot scans the range and exits.

## Risk methodology

SCANETH uses static analysis only. It cannot prove a contract is safe; it can only flag known unsafe patterns. A low score means "none of the common red flags were found," not "this token is a good investment." Always do your own research before interacting with any contract.

## Deployment

SCANETH is designed to run continuously on Railway. The `railway.json` and `Procfile` are included; set the environment variables in the Railway dashboard and the healthcheck on `/health` will keep the service alive.

## Layout

```
src/index.ts              Entry point
src/config.ts             Environment parsing
src/server.ts             /health, /stats, /alerts
src/logger.ts             Structured JSON/coloured logs
src/state.ts              In-memory run state
src/scaneth/
  types.ts                Domain types
  constants.ts            Mainnet addresses and risk patterns
  provider.ts             RPC/WS provider setup
  scanner.ts              Block scanner
  analyzer.ts             Risk scoring and alert formatting
  notifier.ts             Telegram integration
```
