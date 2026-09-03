/**
 * SCANETH token analyzer and alert formatter.
 *
 * New plan: alert on EVERY new ETH token launch as soon as it is detected.
 * The alert includes the token name, exact address, scam rating, and a short
 * pros/cons list derived from on-chain safety and bytecode checks.
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

/** Alert on every new launch with complete on-chain metadata. */
export function shouldAlert(launch: TokenLaunch): boolean {
  return launch.metadata.complete;
}

/** Format the immediate launch alert. */
export function formatAlert(launch: TokenLaunch): string {
  const ds = launch.dexScreener;
  const pair = ds?.pair;
  const age = ds ? formatAge(ds.ageMs) : 'just launched';
  const s = launch.safety;

  const rating = scamRating(s.score, s.sellable);
  const { pros, cons } = buildProsCons(launch);

  const links = [
    `<a href="https://etherscan.io/token/${launch.tokenAddress}">Etherscan</a>`,
  ];
  if (pair?.pairAddress) {
    links.push(`<a href="https://dexscreener.com/ethereum/${pair.pairAddress}">DEXScreener</a>`);
  }

  const price = pair?.priceUsd ? `$${Number(pair.priceUsd).toExponential(4)}` : 'unknown';

  return (
    `<b>SCANETH — New ETH token launched</b>\n\n` +
    `<b>${escapeHtml(launch.metadata.name)} (${escapeHtml(launch.metadata.symbol)})</b>\n` +
    `Address: <code>${launch.tokenAddress}</code>\n` +
    `Age: <b>${age}</b>\n` +
    `Price: ${price}\n\n` +
    `<b>Scam rating: ${s.score}/100 — ${rating.label}</b>\n` +
    `${rating.explanation}\n\n` +
    (pros.length ? `<b>Pros</b>\n${pros.join('\n')}\n\n` : '') +
    (cons.length ? `<b>Cons</b>\n${cons.join('\n')}\n\n` : '') +
    links.join(' · ')
  );
}

function scamRating(score: number, sellable: boolean): { label: string; explanation: string } {
  if (!sellable) {
    return {
      label: 'HONEYPOT',
      explanation: 'Sell simulation failed — you may not be able to exit. Treat as a scam.',
    };
  }
  if (score <= 20) {
    return {
      label: 'LOW RISK',
      explanation: 'No major red flags detected. Still DYOR before buying.',
    };
  }
  if (score <= 50) {
    return {
      label: 'CAUTION',
      explanation: 'Some risk flags present. Consider a small position only.',
    };
  }
  if (score <= 75) {
    return {
      label: 'RISKY',
      explanation: 'Several red flags. High chance of loss.',
    };
  }
  return {
    label: 'LIKELY SCAM',
    explanation: 'Multiple severe red flags. Avoid or treat as a gamble.',
  };
}

function buildProsCons(launch: TokenLaunch): { pros: string[]; cons: string[] } {
  const pros: string[] = [];
  const cons: string[] = [];
  const s = launch.safety;

  if (s.sellable) pros.push('✅ Sellable — simulated sell succeeded');
  else cons.push('🚨 Not sellable — possible honeypot');

  if (s.lpLockedOrBurned) pros.push('✅ Liquidity locked or burned');
  else cons.push('🚨 Liquidity unlocked');

  if (s.ownershipRenounced) pros.push('✅ Ownership renounced');
  else if (s.hasAdminFunctions) cons.push('🚨 Active owner + admin functions');

  if (!s.hasAdminFunctions && !s.ownershipRenounced) pros.push('✅ No admin functions detected');

  if (!s.concentrated) pros.push('✅ Supply not overly concentrated');
  else cons.push(`🚨 Top holder owns ${s.topHolderPct.toFixed(1)}%`);

  const tax = Number.isFinite(s.roundTripTaxBps) ? s.roundTripTaxBps / 100 : null;
  if (tax !== null) {
    if (tax <= 5) pros.push(`✅ Low tax (${tax.toFixed(2)}%)`);
    else if (tax >= 20) cons.push(`🚨 High tax (${tax.toFixed(2)}%)`);
    else cons.push(`⚠️ Moderate tax (${tax.toFixed(2)}%)`);
  }

  for (const finding of launch.risk.findings) {
    cons.push(`🚨 ${finding.label}`);
  }

  for (const finding of s.findings) {
    if (finding.key === 'high_tax') {
      // already covered above
      continue;
    }
    if (finding.key === 'concentrated_supply') {
      // already covered above
      continue;
    }
    if (finding.key === 'renounced') {
      // already covered above
      continue;
    }
    cons.push(`🚨 ${finding.label}`);
  }

  return { pros, cons };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
