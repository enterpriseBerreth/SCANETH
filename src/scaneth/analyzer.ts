/**
 * SCANETH token risk analyzer.
 *
 * Combines bytecode heuristics with on-chain metadata reads. Nothing here
 * executes a trade; the goal is to surface launches worth human review.
 */

import { Contract, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import {
  BURN_ADDRESSES,
  DEX_FACTORIES,
  ERC20,
  RISK_PATTERNS,
  RISK_TIERS,
  ZERO_ADDRESS,
} from './constants';
import type { LiquidityEvent, RiskFinding, RiskReport, TokenLaunch, TokenMetadata } from './types';

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
  deployer: string,
): Promise<RiskReport> {
  const findings: RiskFinding[] = [];

  // 1. Bytecode static analysis.
  try {
    const code = await provider.getCode(tokenAddress);
    findings.push(...analyzeBytecode(code));
  } catch (err) {
    log.debug('getCode failed', { address: tokenAddress, ...errMeta(err) });
  }

  // 2. Metadata-derived checks.
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

  if (meta.totalSupply > 0n && meta.totalSupply < 1_000_000n * 10n ** BigInt(meta.decimals || 18)) {
    findings.push({
      key: 'tiny_supply',
      label: 'Very small total supply (under 1M tokens)',
      points: 5,
      critical: false,
    });
  }

  // 3. Deployer reputation proxy: contracts deployed by contracts get a small
  // trust bump because they are likely launchpads; EOAs are neutral.
  try {
    const deployerCode = await provider.getCode(deployer);
    if (deployerCode === '0x') {
      findings.push({
        key: 'eoa_deployer',
        label: 'Deployed by an EOA (no launchpad contract)',
        points: 5,
        critical: false,
      });
    }
  } catch {
    // ignore
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

  // Additional structural heuristics.
  const hasDelegateCall = lowered.includes('f4'); // DELEGATECALL opcode
  const hasCallValue = lowered.includes('34'); // CALLVALUE opcode
  const hasExtCodeSize = lowered.includes('3b'); // EXTCODESIZE opcode

  if (hasDelegateCall && hasCallValue) {
    findings.push({
      key: 'delegatecall_payable',
      label: 'Payable contract with DELEGATECALL — proxy rug risk',
      points: 20,
      critical: false,
    });
  }

  if (!lowered.includes(ERC20.Transfer.slice(2))) {
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
 * Pair a newly created token with any liquidity event that references it.
 * SCANETH only reports tokens that actually received DEX liquidity.
 */
export function pairLiquidity(
  tokenAddress: string,
  liquidityEvents: LiquidityEvent[],
): LiquidityEvent[] {
  const lowered = tokenAddress.toLowerCase();
  return liquidityEvents.filter(
    (ev) =>
      ev.tokenAddress.toLowerCase() === lowered ||
      ev.poolAddress.toLowerCase() === lowered,
  );
}

/**
 * Decide whether a launch is worth alerting. SCANETH is conservative: only
 * low-risk tokens with real liquidity and some metadata completeness qualify.
 */
export function shouldAlert(launch: TokenLaunch, minScore: number): boolean {
  if (launch.risk.tier === 'critical') return false;
  if (launch.risk.score > minScore) return false;
  if (launch.liquidity.length === 0) return false;
  if (!launch.metadata.complete) return false;
  return true;
}

/** Format a launch into a concise Telegram alert. */
export function formatAlert(launch: TokenLaunch, chainLabel: string): string {
  const firstLiq = launch.liquidity[0];
  const links = [
    `<a href="https://etherscan.io/token/${launch.tokenAddress}">Token</a>`,
    `<a href="https://etherscan.io/address/${launch.deployer}">Deployer</a>`,
  ];
  if (firstLiq) {
    links.push(`<a href="https://etherscan.io/address/${firstLiq.poolAddress}">Pool</a>`);
    links.push(`<a href="https://etherscan.io/tx/${firstLiq.txHash}">Tx</a>`);
  }

  const findings = launch.risk.findings
    .filter((f) => f.points > 0)
    .slice(0, 5)
    .map((f) => `• ${f.label} (${f.points} pts)`)
    .join('\n') || 'No major red flags detected.';

  return (
    `<b>SCANETH — New low-risk launch</b>\n\n` +
    `<b>${escapeHtml(launch.metadata.name)} (${escapeHtml(launch.metadata.symbol)})</b>\n` +
    `Risk score: <b>${launch.risk.score}/100 (${launch.risk.tier})</b>\n` +
    `Decimals: ${launch.metadata.decimals}\n` +
    `Total supply: ${formatSupply(launch.metadata.totalSupply, launch.metadata.decimals)}\n` +
    `Block: ${launch.blockNumber}\n\n` +
    `<b>Liquidity</b>\n` +
    `${launch.liquidity
      .map(
        (l) =>
          `• ${l.dex} — ${shorten(l.poolAddress)} ${l.lpLockedOrBurned ? '(LP locked/burned)' : ''}`,
      )
      .join('\n')}\n\n` +
    `<b>Risk findings</b>\n${findings}\n\n` +
    links.join(' · ')
  );
}

function formatSupply(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const div = 10n ** BigInt(decimals || 18);
  const whole = raw / div;
  const frac = raw % div;
  const fracStr = frac.toString().padStart(decimals || 18, '0').slice(0, 4);
  return `${whole.toString()}.${fracStr}`;
}

function shorten(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
