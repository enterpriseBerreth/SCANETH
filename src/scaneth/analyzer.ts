/**
 * SCANETH token analyzer and alert formatter.
 *
 * New plan: alert on every brand-new ETH token launch as soon as it reaches
 * 7 buys. Safety/rug checks are reported but never block the alert. An ATH/PNL
 * follow-up alert is sent later by the tracker.
 */

import { Contract, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { RISK_PATTERNS, RISK_TIERS } from './constants';
import type { RiskFinding, RiskReport, TokenLaunch, TokenMetadata } from './types';
import { formatAge } from './dexscreener';

const log = createLogger('scaneth:analyzer');

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

interface Erc20ViewContract {
  name(): Promise<unknown>;
  symbol(): Promise<unknown>;
  decimals(): Promise<unknown>;
  totalSupply(): Promise<unknown>;
}

/** Read ERC-20 metadata with individual try/catch so one bad call does not lose everything. */
export async function readTokenMetadata(
  provider: Provider,
  address: string,
): Promise<TokenMetadata> {
  const contract = new Contract(address, ERC20_ABI, provider) as unknown as Erc20ViewContract;
  const meta: TokenMetadata = {
    name: '',
    symbol: '',
    decimals: 18,
    totalSupply: 0n,
    complete: false,
  };

  try {
    meta.name = String(await contract.name());
  } catch (err) {
    log.debug('name() failed', { address, ...errMeta(err) });
  }
  try {
    meta.symbol = String(await contract.symbol());
  } catch (err) {
    log.debug('symbol() failed', { address, ...errMeta(err) });
  }
  try {
    meta.decimals = Number(await contract.decimals());
  } catch (err) {
    log.debug('decimals() failed', { address, ...errMeta(err) });
  }
  try {
    meta.totalSupply = BigInt(String(await contract.totalSupply()));
  } catch (err) {
    log.debug('totalSupply() failed', { address, ...errMeta(err) });
  }

  meta.complete = meta.name !== '' && meta.symbol !== '' && meta.totalSupply > 0n;
  return meta;
}

/** Build a score from bytecode and metadata. */
export async function analyzeToken(
  provider: Provider,
  tokenAddress: string,
  _deployer: string,
): Promise<RiskReport> {
  const findings: RiskFinding[] = [];

  try {
    const code = await provider.getCode(tokenAddress);
    findings.push(...analyzeBytecode(code));
  } catch (err) {
    log.debug('getCode failed', { address: tokenAddress, ...errMeta(err) });
  }

  const meta = await readTokenMetadata(provider, tokenAddress);

  if (!meta.complete) {
    findings.push({
      key: 'incomplete_metadata',
      label: 'ERC-20 metadata incomplete (name/symbol/totalSupply)',
      points: 10,
      critical: false,
    });
  }

  if (meta.totalSupply === 0n) {
    findings.push({
      key: 'zero_supply',
      label: 'Token reports zero total supply',
      points: 15,
      critical: false,
    });
  }

  const score = Math.min(100, findings.reduce((sum, f) => sum + f.points, 0));
  const tier = tierForScore(score);

  return { score, tier, findings };
}

/** Static bytecode red-flag scan. */
export function analyzeBytecode(bytecode: string): RiskFinding[] {
  const findings: RiskFinding[] = [];
  if (!bytecode || bytecode === '0x') return findings;

  const lowered = bytecode.toLowerCase();

  for (const pattern of RISK_PATTERNS) {
    const needle = pattern.hex.slice(2).toLowerCase();
    if (lowered.includes(needle)) {
      findings.push({
        key: pattern.key,
        label: pattern.label,
        points: pattern.points,
        critical: pattern.critical,
      });
    }
  }

  const hasDelegateCall = lowered.includes('f4');
  const hasCallValue = lowered.includes('34');

  if (hasDelegateCall && hasCallValue) {
    findings.push({
      key: 'delegatecall_payable',
      label: 'Payable contract with DELEGATECALL — proxy rug risk',
      points: 20,
      critical: false,
    });
  }

  if (!lowered.includes('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')) {
    findings.push({
      key: 'missing_transfer_event',
      label: 'Bytecode does not emit Transfer event — likely not ERC-20 compliant',
      points: 50,
      critical: true,
    });
  }

  return findings;
}

export function tierForScore(score: number): import('./types').RiskTier {
  if (score <= RISK_TIERS.low.max) return 'low';
  if (score <= RISK_TIERS.medium.max) return 'medium';
  if (score <= RISK_TIERS.high.max) return 'high';
  return 'critical';
}

/** Sum buys across all DEXScreener time buckets. */
export function totalBuys(launch: TokenLaunch): number {
  const txns = launch.dexScreener?.pair.txns;
  if (!txns) return 0;
  return (txns.m5?.buys ?? 0) + (txns.h1?.buys ?? 0) + (txns.h6?.buys ?? 0) + (txns.h24?.buys ?? 0);
}

/**
 * Alert trigger: any new ETH token launch that has 7 or more buys.
 * Safety status is reported in the alert but never blocks it.
 */
export function shouldAlert(launch: TokenLaunch, minBuys: number): boolean {
  if (!launch.dexScreener) return false;
  if (!launch.metadata.complete) return false;
  return totalBuys(launch) >= minBuys;
}

/** Format the initial launch alert. */
export function formatAlert(launch: TokenLaunch): string {
  const ds = launch.dexScreener!;
  const pair = ds.pair;
  const age = formatAge(ds.ageMs);
  const s = launch.safety;
  const buys = totalBuys(launch);

  const links = [
    `<a href="https://etherscan.io/token/${launch.tokenAddress}">Etherscan</a>`,
    `<a href="https://dexscreener.com/ethereum/${pair.pairAddress}">DEXScreener</a>`,
  ];

  const price = pair.priceUsd ? `$${Number(pair.priceUsd).toExponential(4)}` : 'unknown';
  const verdict = safetyVerdict(s);

  return (
    `<b>SCANETH — New launch hit ${buys} buys</b>\n\n` +
    `<b>${escapeHtml(launch.metadata.name)} (${escapeHtml(launch.metadata.symbol)})</b>\n` +
    `Address: <code>${launch.tokenAddress}</code>\n` +
    `Age: <b>${age}</b>\n` +
    `Price: ${price}\n\n` +
    `<b>Legitimacy check</b>\n` +
    `${verdict}\n\n` +
    `Risk score: ${launch.risk.score}/100 (${launch.risk.tier}) · Safety score: ${s.score}/100\n\n` +
    links.join(' · ')
  );
}

export function safetyVerdict(s: TokenLaunch['safety']): string {
  if (!s.sellable) {
    return '⚠️ Likely honeypot — sell simulation failed. NOT a good buy.';
  }
  if (s.score <= 20) {
    return '✅ Looks legitimate — no major red flags. Potential good buy.';
  }
  if (s.score <= 50) {
    return `⚠️ Some risk flags (${s.findings.slice(0, 2).map((f) => f.label).join('; ')}). Caution advised.`;
  }
  return `🚨 High rug risk — ${s.findings.slice(0, 2).map((f) => f.label).join('; ')}. NOT a good buy.`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
