/**
 * SCANETH token risk analyzer and alert formatter.
 *
 * Combines bytecode heuristics with on-chain metadata reads. Nothing here
 * executes a trade; the goal is to surface launches worth human review.
 */

import { Contract, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { BURN_ADDRESSES, ETHEREUM, RISK_PATTERNS, RISK_TIERS, ZERO_ADDRESS } from './constants';
import type { RiskFinding, RiskReport, SafetyReport, TokenLaunch, TokenMetadata } from './types';
import type { ScanFilters } from './scanner';
import { formatAge } from './dexscreener';

const log = createLogger('scaneth:analyzer');

const WETH_ADDRESS = ETHEREUM.wrappedNative.toLowerCase();
const ROUTER_ADDRESSES = [
  '0x7a250d0f2f7b0c1b8d9f0e1f0d6b8f8d9a8e1b0a'.toLowerCase(),
  '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B44'.toLowerCase(),
].filter((value, index, arr) => arr.indexOf(value) === index);

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function maxTxAmount() view returns (uint256)',
  'function maxTransactionAmount() view returns (uint256)',
  'function maxSellAmount() view returns (uint256)',
  'function isBlacklisted(address) view returns (bool)',
  'function paused() view returns (bool)',
];

interface Erc20ViewContract {
  name(): Promise<unknown>;
  symbol(): Promise<unknown>;
  decimals(): Promise<unknown>;
  totalSupply(): Promise<unknown>;
  owner(): Promise<unknown>;
  balanceOf(address: string): Promise<unknown>;
  maxTxAmount(): Promise<unknown>;
  maxTransactionAmount(): Promise<unknown>;
  maxSellAmount(): Promise<unknown>;
  isBlacklisted(address: string): Promise<unknown>;
  paused(): Promise<unknown>;
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

async function scanSafety(
  provider: Provider,
  tokenAddress: string,
  pairAddress?: string,
): Promise<SafetyReport> {
  const criticalIssues: string[] = [];
  const warnings: string[] = [];
  const adminFlags: string[] = [];

  const contract = new Contract(tokenAddress, ERC20_ABI, provider) as unknown as Erc20ViewContract;

  let owner: string | undefined;
  let totalSupply = 0n;
  let ownerBalance = 0n;
  let holderConcentrationPct = 0;
  let maxTxLimit = 0n;
  let blacklisted = false;
  let paused = false;

  try {
    totalSupply = BigInt(String(await contract.totalSupply()));
  } catch {
    // handled by metadata read elsewhere
  }

  try {
    owner = String(await contract.owner()).toLowerCase();
  } catch {
    owner = undefined;
  }

  if (owner && owner !== ZERO_ADDRESS.toLowerCase()) {
    try {
      ownerBalance = BigInt(String(await contract.balanceOf(owner)));
      if (totalSupply > 0n) {
        holderConcentrationPct = Number((ownerBalance * 100n) / totalSupply);
      }
    } catch {
      ownerBalance = 0n;
    }
  }

  if (owner === ZERO_ADDRESS.toLowerCase()) {
    warnings.push('ownership renounced');
  }

  try {
    maxTxLimit = BigInt(String(await contract.maxTxAmount()));
  } catch {
    try {
      maxTxLimit = BigInt(String(await contract.maxTransactionAmount()));
    } catch {
      try {
        maxTxLimit = BigInt(String(await contract.maxSellAmount()));
      } catch {
        maxTxLimit = 0n;
      }
    }
  }

  try {
    blacklisted = Boolean(await contract.isBlacklisted(ZERO_ADDRESS));
  } catch {
    blacklisted = false;
  }

  try {
    paused = Boolean(await contract.paused());
  } catch {
    paused = false;
  }

  if (paused) {
    criticalIssues.push('pause function enabled');
    adminFlags.push('pause');
  }

  if (blacklisted) {
    criticalIssues.push('blacklist function active');
    adminFlags.push('blacklist');
  }

  let buyTaxPct = 0;
  let maxTxBlocksSell = false;
  let honeypot = false;
  let lpBurned = false;

  const code = await provider.getCode(tokenAddress).catch(() => '0x');
  const loweredCode = code.toLowerCase();
  const adminMarkers = [
    { flag: 'mint', matcher: '40c10f19' },
    { flag: 'pause', matcher: '8456cb59' },
    { flag: 'blacklist', matcher: '3ec54e' },
    { flag: 'owner-renounce', matcher: '715018a6' },
    { flag: 'upgrade', matcher: 'upgrade' },
    { flag: 'implementation', matcher: 'implementation' },
  ];

  for (const entry of adminMarkers) {
    if (loweredCode.includes(entry.matcher) || loweredCode.includes(entry.flag)) {
      adminFlags.push(entry.flag);
    }
  }

  const dedupedAdminFlags = [...new Set(adminFlags)];
  if (dedupedAdminFlags.length > 0) {
    criticalIssues.push(`admin controls detected: ${dedupedAdminFlags.join(', ')}`);
  }

  const honeypotProbe = await simulateHoneypot(provider, tokenAddress);
  honeypot = honeypotProbe.honeypot;
  buyTaxPct = honeypotProbe.buyTaxPct;
  maxTxBlocksSell = honeypotProbe.maxTxBlocksSell || (maxTxLimit > 0n && honeypotProbe.sellOut > maxTxLimit);

  if (honeypot || honeypotProbe.sellOut === 0n) {
    criticalIssues.push('honeypot detected');
  }

  if (maxTxBlocksSell) {
    criticalIssues.push('max transaction limit blocks sell');
  }

  if (buyTaxPct > 15) {
    warnings.push(`buy tax approx ${buyTaxPct}%`);
  }

  if (pairAddress) {
    const pairContract = new Contract(
      pairAddress,
      [
        'function balanceOf(address) view returns (uint256)',
        'function totalSupply() view returns (uint256)',
      ],
      provider,
    ) as unknown as {
      balanceOf(address: string): Promise<unknown>;
      totalSupply(): Promise<unknown>;
    };

    try {
      const totalPairSupply = BigInt(String(await pairContract.totalSupply()));
      const burnedAt = await Promise.all(
        Array.from(BURN_ADDRESSES).map(async (burnAddress) => {
          const balance = await pairContract.balanceOf(burnAddress);
          return BigInt(String(balance));
        }),
      );

      const totalBurned = burnedAt.reduce((sum, v) => sum + v, 0n);
      lpBurned = totalPairSupply > 0n && totalBurned > 0n && totalBurned >= totalPairSupply / 10n;
    } catch {
      lpBurned = false;
    }
  }

  if (!lpBurned) {
    warnings.push('LP burn/lock not confirmed');
  }

  if (holderConcentrationPct > 40) {
    criticalIssues.push(`single wallet holds ${holderConcentrationPct}% of supply`);
  }

  if (owner && owner !== ZERO_ADDRESS.toLowerCase()) {
    warnings.push('ownership still active');
  }

  const okay = criticalIssues.length === 0 && !honeypot && !maxTxBlocksSell;

  return {
    okay,
    criticalIssues,
    warnings,
    honeypot,
    buyTaxPct,
    maxTxBlocksSell,
    lpBurned,
    ownerRenounced: owner === ZERO_ADDRESS.toLowerCase(),
    holderConcentrationPct,
    adminFlags: dedupedAdminFlags,
  };
}

async function simulateHoneypot(
  provider: Provider,
  tokenAddress: string,
): Promise<{ honeypot: boolean; buyTaxPct: number; sellOut: bigint; maxTxBlocksSell: boolean }> {
  const amountIn = 10n ** 17n;
  const buyPath = [WETH_ADDRESS, tokenAddress.toLowerCase()];
  const sellPath = [tokenAddress.toLowerCase(), WETH_ADDRESS];

  for (const routerAddress of ROUTER_ADDRESSES) {
    try {
      const router = new Contract(
        routerAddress,
        ['function getAmountsOut(uint256,address[]) view returns (uint256[])'],
        provider,
      ) as unknown as {
        getAmountsOut(amountIn: bigint, path: string[]): Promise<bigint[]>;
      };

      const buyAmounts = await router.getAmountsOut(amountIn, buyPath);
      const buyOut = buyAmounts[1] ?? 0n;
      if (buyOut === 0n) {
        return { honeypot: true, buyTaxPct: 100, sellOut: 0n, maxTxBlocksSell: true };
      }

      const sellAmounts = await router.getAmountsOut(buyOut, sellPath);
      const sellOut = sellAmounts[1] ?? 0n;
      const retentionPct = Number((sellOut * 10000n) / amountIn) / 100;
      const buyTaxPct = Math.max(0, 100 - retentionPct);
      const maxTxBlocksSell = buyOut > 0n && sellOut === 0n;

      return {
        honeypot: false,
        buyTaxPct,
        maxTxBlocksSell,
        sellOut,
      };
    } catch {
      continue;
    }
  }

  return {
    honeypot: true,
    buyTaxPct: 100,
    sellOut: 0n,
    maxTxBlocksSell: true,
  };
}

/** Build a score from bytecode and metadata. */
export async function analyzeToken(
  provider: Provider,
  tokenAddress: string,
  _deployer: string,
  pairAddress?: string,
): Promise<RiskReport> {
  const findings: RiskFinding[] = [];

  try {
    const code = await provider.getCode(tokenAddress);
    findings.push(...analyzeBytecode(code));
  } catch (err) {
    log.debug('getCode failed', { address: tokenAddress, ...errMeta(err) });
  }

  const safety = await scanSafety(provider, tokenAddress, pairAddress);
  if (safety.criticalIssues.length > 0) {
    for (const issue of safety.criticalIssues) {
      findings.push({
        key: `safety_${issue.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
        label: issue,
        points: 25,
        critical: true,
      });
    }
  }

  if (safety.buyTaxPct > 15) {
    findings.push({
      key: 'high_buy_tax',
      label: `High buy tax approximately ${safety.buyTaxPct}%`,
      points: 15,
      critical: false,
    });
  }

  if (safety.holderConcentrationPct > 40) {
    findings.push({
      key: 'holder_concentration',
      label: `Single wallet holds ${safety.holderConcentrationPct}% of supply`,
      points: 20,
      critical: false,
    });
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

  return { score, tier, findings, safety };
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
 *   - metadata must be complete
 */
export function shouldAlert(launch: TokenLaunch, filters: ScanFilters): boolean {
  if (!launch.dexScreener) return false;
  if (!launch.metadata.complete) return false;
  if (launch.risk.score > filters.maxRiskScore) return false;

  const safety = launch.risk.safety;
  if (safety && !safety.okay) return false;

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

  const links = [
    `<a href="https://etherscan.io/token/${launch.tokenAddress}">Etherscan</a>`,
    `<a href="https://dexscreener.com/ethereum/${pair.pairAddress}">DEXScreener</a>`,
  ];

  const mcap = pair.marketCap ? `$${formatNumber(pair.marketCap)}` : 'unknown';
  const liquidity = pair.liquidity?.usd ? `$${formatNumber(pair.liquidity.usd)}` : 'unknown';
  const price = pair.priceUsd ? `$${Number(pair.priceUsd).toExponential(4)}` : 'unknown';
  const safety = launch.risk.safety;
  const safetySummary = safety
    ? safety.okay
      ? 'safety: pass'
      : `safety: fail (${safety.criticalIssues.join(', ') || 'unknown'})`
    : 'safety: unknown';

  return (
    `<b>SCANETH — Active new launch</b>\n\n` +
    `<b>${escapeHtml(launch.metadata.name)} (${escapeHtml(launch.metadata.symbol)})</b>\n` +
    `Address: <code>${launch.tokenAddress}</code>\n` +
    `Age: <b>${age}</b>\n` +
    `Price: ${price}\n` +
    `Market cap: ${mcap}\n` +
    `Liquidity: ${liquidity}\n` +
    `${safetySummary}\n\n` +
    `<b>Past hour activity</b>\n` +
    `Txns: <b>${ds.h1Txns}</b>\n` +
    `Buys: ${ds.h1Buys}\n` +
    `Sells: <b>${ds.h1Sells}</b>\n\n` +
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
