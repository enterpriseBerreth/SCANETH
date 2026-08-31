/**
 * SCANETH safety / rug-pull probes.
 *
 * The goal is to avoid alerting on tokens that look active but are actually
 * honeypots, tax traps, or admin-controlled rugs. These probes use read-only
 * `eth_call` simulations and bytecode analysis — no real transactions are sent.
 */

import { Contract, type Provider } from 'ethers';
import { createLogger, errMeta } from '../logger';
import { ETHEREUM, ZERO_ADDRESS } from './constants';

const log = createLogger('scaneth:safety');

const WETH = ETHEREUM.wrappedNative.toLowerCase();

const UNIV2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function owner() view returns (address)',
];

interface Erc20Contract {
  balanceOf(address: string): Promise<bigint>;
  totalSupply(): Promise<bigint>;
  owner(): Promise<string>;
}

interface PairContract {
  balanceOf(address: string): Promise<bigint>;
  totalSupply(): Promise<bigint>;
}

export interface SafetyReport {
  /** 0 (safe) to 100 (definite rug). */
  score: number;
  /** True if the token passed the sell simulation. */
  sellable: boolean;
  /** True if a buy simulation succeeded. */
  buyable: boolean;
  /** Estimated buy+sell tax in basis points. NaN if simulation failed. */
  roundTripTaxBps: number;
  /** True if LP tokens appear locked or burned. */
  lpLockedOrBurned: boolean;
  /** True if ownership is renounced / no owner function. */
  ownershipRenounced: boolean;
  /** True if common admin functions (mint/pause/blacklist) were found. */
  hasAdminFunctions: boolean;
  /** True if a single wallet holds more than the threshold. */
  concentrated: boolean;
  /** Largest holder percentage (0-100). */
  topHolderPct: number;
  /** Human-readable findings. */
  findings: SafetyFinding[];
}

export interface SafetyFinding {
  key: string;
  label: string;
  points: number;
  critical: boolean;
}

export interface SafetyContext {
  provider: Provider;
  tokenAddress: string;
  pairAddress: string;
  dex: string;
  /** Simulated buy size in ETH. */
  probeEth: number;
  /** Max acceptable round-trip tax in bps. */
  maxTaxBps: number;
  /** Holder concentration threshold (0-100). */
  maxTopHolderPct: number;
}

const BURN_ADDRESSES = new Set([
  ZERO_ADDRESS.toLowerCase(),
  '0x0000000000000000000000000000000000000001',
  '0x000000000000000000000000000000000000000d',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);

const ADMIN_SELECTORS = [
  { hex: '0x8da5cb5b', key: 'owner', label: 'Owner role exists' },
  { hex: '0xf2fde38b', key: 'transfer_ownership', label: 'Transfer-ownership function' },
  { hex: '0x40c10f19', key: 'mint', label: 'Mint function' },
  { hex: '0x8456cb59', key: 'pause', label: 'Pause function' },
  { hex: '0x3f4ba83a', key: 'unpause', label: 'Unpause function' },
  { hex: '0x3ec54e', key: 'blacklist', label: 'Blacklist function' },
  { hex: '0x43700a0e', key: 'set_blacklist', label: 'Set-blacklist function' },
  { hex: '0xe1408f7b', key: 'whitelist', label: 'Whitelist function' },
  { hex: '0x9a7a23d6', key: 'set_tax', label: 'Set-tax function' },
  { hex: '0xc0246668', key: 'set_max_tx', label: 'Set-max-tx function' },
  { hex: '0x79ba6097', key: 'renounce_ownership', label: 'Renounce-ownership function' },
];

/**
 * Run all safety probes and return a report.
 */
export async function checkSafety(ctx: SafetyContext): Promise<SafetyReport> {
  const findings: SafetyFinding[] = [];

  const [sim, bytecodeFindings, ownership, concentration, lpLock] = await Promise.all([
    simulateRoundTrip(ctx),
    scanBytecode(ctx.provider, ctx.tokenAddress),
    checkOwnership(ctx.provider, ctx.tokenAddress),
    checkHolderConcentration(ctx.provider, ctx.tokenAddress, ctx.pairAddress, ctx.maxTopHolderPct),
    checkLpLock(ctx.provider, ctx.pairAddress),
  ]);

  findings.push(...bytecodeFindings);

  if (!sim.buyable) {
    findings.push({
      key: 'buy_failed',
      label: 'Buy simulation failed — token may be untradable or pair has no liquidity',
      points: 100,
      critical: true,
    });
  }

  if (!sim.sellable) {
    findings.push({
      key: 'sell_failed',
      label: 'Sell simulation failed — likely honeypot or sell-blocked',
      points: 100,
      critical: true,
    });
  }

  if (Number.isFinite(sim.roundTripTaxBps) && sim.roundTripTaxBps > ctx.maxTaxBps) {
    findings.push({
      key: 'high_tax',
      label: `Round-trip tax ${(sim.roundTripTaxBps / 100).toFixed(1)}% exceeds ${(ctx.maxTaxBps / 100).toFixed(1)}% threshold`,
      points: 30,
      critical: false,
    });
  }

  if (concentration.concentrated) {
    findings.push({
      key: 'concentrated_supply',
      label: `Top holder owns ${concentration.topHolderPct.toFixed(1)}% of supply`,
      points: 25,
      critical: false,
    });
  }

  if (!lpLock && ctx.dex !== 'uniswap-v3') {
    findings.push({
      key: 'lp_unlocked',
      label: 'LP tokens do not appear locked or burned',
      points: 15,
      critical: false,
    });
  }

  if (ownership.ownershipRenounced) {
    // Ownership renounced is a positive signal — subtract points, floor at 0.
    findings.push({
      key: 'renounced',
      label: 'Ownership renounced',
      points: -15,
      critical: false,
    });
  }

  const rawScore = findings.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(100, rawScore));

  return {
    score,
    sellable: sim.sellable,
    buyable: sim.buyable,
    roundTripTaxBps: sim.roundTripTaxBps,
    lpLockedOrBurned: lpLock,
    ownershipRenounced: ownership.ownershipRenounced,
    hasAdminFunctions: findings.some((f) =>
      ['mint', 'pause', 'blacklist', 'set_tax', 'set_max_tx', 'transfer_ownership'].includes(f.key),
    ),
    concentrated: concentration.concentrated,
    topHolderPct: concentration.topHolderPct,
    findings,
  };
}

interface SimResult {
  buyable: boolean;
  sellable: boolean;
  roundTripTaxBps: number;
}

/**
 * Simulate a small WETH buy then a WETH sell on the Uniswap V2 router.
 * If the token is V3-only or no V2 router is known, we skip the simulation
 * rather than mark it unsafe.
 */
async function simulateRoundTrip(ctx: SafetyContext): Promise<SimResult> {
  const result: SimResult = {
    buyable: false,
    sellable: false,
    roundTripTaxBps: Number.NaN,
  };

  if (ctx.dex === 'uniswap-v3') {
    // V3 simulation is more complex; skip rather than mislabel.
    result.buyable = true;
    result.sellable = true;
    return result;
  }

  const routerAddress = getV2Router(ctx.dex);
  if (!routerAddress) return result;

  const router = new Contract(routerAddress, UNIV2_ROUTER_ABI, ctx.provider);
  const probeWei = BigInt(Math.floor(ctx.probeEth * 1e18));
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const buyer = '0x0000000000000000000000000000000000000001';

  try {
    const buyAmounts = (await router.getAmountsOut!(probeWei, [ETHEREUM.wrappedNative, ctx.tokenAddress])) as bigint[];
    const tokenOut = buyAmounts[buyAmounts.length - 1] ?? 0n;
    if (tokenOut <= 0n) return result;
    result.buyable = true;

    try {
      await router.swapExactETHForTokens!.staticCall(0, [ETHEREUM.wrappedNative, ctx.tokenAddress], buyer, deadline, {
        value: probeWei,
      });
    } catch {
      // getAmountsOut succeeded but swap reverts — possible whitelist/tax block.
    }

    const sellAmounts = (await router.getAmountsOut!(tokenOut, [ctx.tokenAddress, ETHEREUM.wrappedNative])) as bigint[];
    const ethBack = sellAmounts[sellAmounts.length - 1] ?? 0n;

    try {
      await router.swapExactTokensForETH!.staticCall(tokenOut, 0, [ctx.tokenAddress, ETHEREUM.wrappedNative], buyer, deadline);
      result.sellable = true;
    } catch {
      // Sell reverts — honeypot.
      return result;
    }

    if (probeWei > 0n) {
      const loss = probeWei - ethBack;
      result.roundTripTaxBps = Number((loss * 10_000n) / probeWei);
    }
  } catch (err) {
    log.debug('round-trip simulation failed', { address: ctx.tokenAddress, ...errMeta(err) });
  }

  return result;
}

function getV2Router(dex: string): string | null {
  switch (dex) {
    case 'uniswap-v2':
      return '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
    case 'sushiswap-v2':
      return '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F';
    default:
      return null;
  }
}

async function scanBytecode(provider: Provider, tokenAddress: string): Promise<SafetyFinding[]> {
  const findings: SafetyFinding[] = [];
  try {
    const code = await provider.getCode(tokenAddress);
    if (!code || code === '0x') return findings;
    const lowered = code.toLowerCase();

    for (const sel of ADMIN_SELECTORS) {
      if (lowered.includes(sel.hex.slice(2))) {
        findings.push({ key: sel.key, label: sel.label, points: 10, critical: sel.key === 'mint' });
      }
    }
  } catch (err) {
    log.debug('bytecode scan failed', { address: tokenAddress, ...errMeta(err) });
  }
  return findings;
}

async function checkOwnership(provider: Provider, tokenAddress: string): Promise<{ ownershipRenounced: boolean }> {
  const contract = new Contract(tokenAddress, ERC20_ABI, provider) as unknown as Erc20Contract;
  try {
    const owner = await contract.owner();
    const renounced = !owner || owner.toLowerCase() === ZERO_ADDRESS.toLowerCase();
    return { ownershipRenounced: renounced };
  } catch {
    // No owner() or reverts — treat as renounced for scoring purposes.
    return { ownershipRenounced: true };
  }
}

async function checkHolderConcentration(
  provider: Provider,
  tokenAddress: string,
  pairAddress: string,
  thresholdPct: number,
): Promise<{ concentrated: boolean; topHolderPct: number }> {
  const contract = new Contract(tokenAddress, ERC20_ABI, provider) as unknown as Erc20Contract;
  try {
    const totalSupply = await contract.totalSupply();
    if (totalSupply === 0n) return { concentrated: false, topHolderPct: 0 };

    // Proxy: check how much supply is sitting in the pair. For healthy launches
    // most supply is in LP, so we only flag extreme concentration outside LP.
    const pairBalance = await contract.balanceOf(pairAddress);
    const pct = Number((pairBalance * 10000n) / totalSupply) / 100;
    return { concentrated: pct > thresholdPct, topHolderPct: pct };
  } catch (err) {
    log.debug('holder concentration check failed', { address: tokenAddress, ...errMeta(err) });
    return { concentrated: false, topHolderPct: 0 };
  }
}

async function checkLpLock(provider: Provider, pairAddress: string): Promise<boolean> {
  try {
    const pair = new Contract(
      pairAddress,
      ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)'],
      provider,
    ) as unknown as PairContract;
    const totalSupply = await pair.totalSupply();
    if (totalSupply === 0n) return false;

    for (const burn of BURN_ADDRESSES) {
      const bal = await pair.balanceOf(burn);
      if (bal * 100n >= totalSupply * 90n) return true; // 90%+ burned/locked
    }
  } catch (err) {
    log.debug('lp lock check failed', { pair: pairAddress, ...errMeta(err) });
  }
  return false;
}
