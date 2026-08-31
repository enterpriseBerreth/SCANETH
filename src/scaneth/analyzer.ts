/**
 * SCANETH token risk analyzer and alert formatter.
 *
 * Combines bytecode heuristics with on-chain metadata reads. Nothing here
 * executes a trade; the goal is to surface launches worth human review.
 */

import { Contract, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { RISK_PATTERNS, RISK_TIERS } from './constants';
import type { RiskFinding, RiskReport, TokenLaunch, TokenMetadata } from './types';
import type { ScanFilters } from './scanner';
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

/**
 * Decide whether a launch is worth alerting.
 *
 * Filters:
 *   - pair age <= MAX_AGE_HOURS
 *   - h1 transactions >= MIN_H1_TXNS
 *   - h1 sells >= MIN_H1_SELLS
 *   - risk score <= maxRiskScore
 *   - safety score <= maxSafetyScore
 *   - token must be sellable (honeypot check)
 *   - metadata must be complete
 */
export function shouldAlert(launch: TokenLaunch, filters: ScanFilters): boolean {
  if (!launch.dexScreener) return false;
  if (!launch.metadata.complete) return false;
  if (launch.risk.score > filters.maxRiskScore) return false;
  if (launch.safety.score > filters.maxSafetyScore) return false;
  if (!launch.safety.sellable) return false;

  const ageHours = launch.dexScreener.ageMs / 3_600_000;
  if (ageHours > filters.maxAgeHours) return false;
  if (launch.dexScreener.h1Txns < filters.minH1Txns) return false;
  if (launch.dexScreener.h1Sells < filters.minH1Sells) return false;

  return true;
}

/** Format a launch into a concise Telegram alert. */
export function formatAlert(launch: TokenLaunch): string {
  const ds = launch.dexScreener!;
  const pair = ds.pair;
  const age = formatAge(ds.ageMs);
  const s = launch.safety;

  const links = [
    `<a href="https://etherscan.io/token/${launch.tokenAddress}">Etherscan</a>`,
    `<a href="https://dexscreener.com/ethereum/${pair.pairAddress}">DEXScreener</a>`,
  ];

  const mcap = pair.marketCap ? `$${formatNumber(pair.marketCap)}` : 'unknown';
  const liquidity = pair.liquidity?.usd ? `$${formatNumber(pair.liquidity.usd)}` : 'unknown';
  const price = pair.priceUsd ? `$${Number(pair.priceUsd).toExponential(4)}` : 'unknown';
  const tax = Number.isFinite(s.roundTripTaxBps) ? `${(s.roundTripTaxBps / 100).toFixed(2)}%` : 'unknown';
  const lpStatus = s.lpLockedOrBurned ? 'locked/burned' : 'unlocked';
  const ownership = s.ownershipRenounced ? 'renounced' : 'active';

  const safetyFlags = [
    s.sellable ? 'sellable' : 'NOT SELLABLE',
    `tax ${tax}`,
    `LP ${lpStatus}`,
    `owner ${ownership}`,
    s.hasAdminFunctions ? 'admin funcs' : 'no admin funcs',
    s.concentrated ? `top holder ${s.topHolderPct.toFixed(1)}%` : 'supply not concentrated',
  ].join(' · ');

  return (
    `<b>SCANETH — Active new launch</b>\n\n` +
    `<b>${escapeHtml(launch.metadata.name)} (${escapeHtml(launch.metadata.symbol)})</b>\n` +
    `Address: <code>${launch.tokenAddress}</code>\n` +
    `Age: <b>${age}</b>\n` +
    `Price: ${price}\n` +
    `Market cap: ${mcap}\n` +
    `Liquidity: ${liquidity}\n\n` +
    `<b>Past hour activity</b>\n` +
    `Txns: <b>${ds.h1Txns}</b>\n` +
    `Buys: ${ds.h1Buys}\n` +
    `Sells: <b>${ds.h1Sells}</b>\n\n` +
    `<b>Safety check</b>\n` +
    `Score: ${s.score}/100\n` +
    `${safetyFlags}\n\n` +
    `Risk score: ${launch.risk.score}/100 (${launch.risk.tier})\n\n` +
    links.join(' · ')
  );
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
