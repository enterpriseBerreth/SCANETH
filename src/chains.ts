/**
 * Chain registry: RPC-independent on-chain constants.
 *
 * Every address here is a mainnet deployment. They are validated at startup
 * (see onchain/validate.ts) — a venue whose factory/quoter does not respond
 * correctly is disabled rather than allowed to produce phantom quotes.
 *
 * Scope note: only true Uniswap-V2 forks (constant product, fixed fee) and
 * Uniswap V3 are included. Solidly forks (Aerodrome, Velodrome) and dynamic-fee
 * forks (Camelot) use different router signatures and fee models — pricing them
 * with the V2 formula would invent profit that does not exist, so they are
 * deliberately excluded until they get purpose-built adapters.
 */

import type { ChainConfig, ChainName, TokenInfo } from './types';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const UNIV3_FEE_TIERS = [100, 500, 3000, 10_000];

/** Uniswap V3 QuoterV2 and SwapRouter02 share addresses across most L2s. */
const UNIV3_QUOTER_V2_CANONICAL = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const UNIV3_ROUTER02_CANONICAL = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const UNIV3_FACTORY_CANONICAL = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

// ── Base ─────────────────────────────────────────────────────────────────────

const BASE_TOKENS: TokenInfo[] = [
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18, usdHint: 3000 },
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'USDbC', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18, usdHint: 1, stable: true },
  { symbol: 'cbETH', address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18, usdHint: 3200 },
];

const BASE: ChainConfig = {
  name: 'base',
  chainId: 8453,
  label: 'Base',
  nativeSymbol: 'ETH',
  wrappedNative: '0x4200000000000000000000000000000000000006',
  multicall3: MULTICALL3,
  aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  balancerVault: BALANCER_VAULT,
  tokens: BASE_TOKENS,
  venues: [
    {
      id: 'uniswap-v3',
      label: 'Uniswap V3',
      kind: 'univ3',
      router: '0x2626664c2603336E57B271c5C0b26F421741e481',
      factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      feeTiers: UNIV3_FEE_TIERS,
    },
    {
      id: 'uniswap-v2',
      label: 'Uniswap V2',
      kind: 'univ2',
      router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
      feeBps: 30,
    },
    {
      id: 'sushiswap-v2',
      label: 'SushiSwap V2',
      kind: 'univ2',
      router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
      factory: '0x71524B4f93c58fcbF659783284E38825f0622859',
      feeBps: 30,
    },
    {
      id: 'baseswap',
      label: 'BaseSwap',
      kind: 'univ2',
      router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
      factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
      feeBps: 30,
    },
    {
      // The largest venue on Base, and the reason stable-pool support exists.
      // Registering this as 'univ2' would appear to work and return quietly wrong
      // numbers for every stable pool, so the kind matters.
      id: 'aerodrome',
      label: 'Aerodrome',
      kind: 'solidly',
      router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      // Per-pool fees are read from the factory at discovery; this is only the
      // fallback used if that read fails.
      feeBps: 5,
    },
    {
      id: 'curve',
      label: 'Curve',
      kind: 'curve',
      // Curve has no shared router — each swap goes to its pool directly.
      router: '0x0000000000000000000000000000000000000000',
      factory: '0x0000000000000000000000000000000000000000',
      feeBps: 4,
      // Named explicitly rather than enumerated from a registry: Curve's
      // registries disagree across deployments and list long-dead pools, so an
      // enumerated list would mostly be noise. Each entry is verified to respond
      // to `coins()` and `get_dy()` at startup and dropped if it does not.
      curvePools: [
        // USDC/USDbC — verified live via npm run verify:solidly.
        // Other Base Curve pools were tried and did not resolve `coins()`, so
        // they are omitted rather than left in as dead weight.
        '0xf6C5F01C7F3148891ad0e19DF78743D31E390D1f',
      ],
    },
  ],
  pairs: [
    ['WETH', 'USDC'],
    ['WETH', 'DAI'],
    ['WETH', 'USDbC'],
    ['WETH', 'cbETH'],
    ['USDC', 'DAI'],
    ['USDC', 'USDbC'],
  ],
};

// ── Arbitrum ─────────────────────────────────────────────────────────────────

const ARBITRUM_TOKENS: TokenInfo[] = [
  { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18, usdHint: 3000 },
  { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'USDCe', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18, usdHint: 1, stable: true },
  { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8, usdHint: 60_000 },
  { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, usdHint: 0.8 },
];

const ARBITRUM: ChainConfig = {
  name: 'arbitrum',
  chainId: 42161,
  label: 'Arbitrum One',
  nativeSymbol: 'ETH',
  wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  multicall3: MULTICALL3,
  aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  balancerVault: BALANCER_VAULT,
  tokens: ARBITRUM_TOKENS,
  venues: [
    {
      id: 'uniswap-v3',
      label: 'Uniswap V3',
      kind: 'univ3',
      router: UNIV3_ROUTER02_CANONICAL,
      factory: UNIV3_FACTORY_CANONICAL,
      quoter: UNIV3_QUOTER_V2_CANONICAL,
      feeTiers: UNIV3_FEE_TIERS,
    },
    {
      id: 'sushiswap-v2',
      label: 'SushiSwap V2',
      kind: 'univ2',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      feeBps: 30,
    },
    {
      id: 'uniswap-v2',
      label: 'Uniswap V2',
      kind: 'univ2',
      router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
      feeBps: 30,
    },
    {
      id: 'curve',
      label: 'Curve',
      kind: 'curve',
      router: '0x0000000000000000000000000000000000000000',
      factory: '0x0000000000000000000000000000000000000000',
      feeBps: 4,
      curvePools: [
        // 2pool: USDC.e/USDT — the deepest stable pool on Arbitrum, and the one
        // most likely to hold a peg different from the Uniswap pools.
        '0x7f90122BF0700F9E7e1F688fe926940E8839F353',
        // tricrypto: USDT/WBTC/WETH
        '0x960ea3e3C7FB317332d990873d354E18d7645590',
      ],
    },
  ],
  pairs: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WETH', 'DAI'],
    ['WETH', 'WBTC'],
    ['WETH', 'ARB'],
    ['USDC', 'USDT'],
    ['USDC', 'USDCe'],
    ['USDC', 'DAI'],
  ],
};

// ── Ethereum ─────────────────────────────────────────────────────────────────

const ETHEREUM_TOKENS: TokenInfo[] = [
  { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, usdHint: 3000 },
  { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, usdHint: 1, stable: true },
  { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, usdHint: 1, stable: true },
  { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8, usdHint: 60_000 },
];

const ETHEREUM: ChainConfig = {
  name: 'ethereum',
  chainId: 1,
  label: 'Ethereum',
  nativeSymbol: 'ETH',
  wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  multicall3: MULTICALL3,
  aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  balancerVault: BALANCER_VAULT,
  tokens: ETHEREUM_TOKENS,
  venues: [
    {
      id: 'uniswap-v3',
      label: 'Uniswap V3',
      kind: 'univ3',
      router: UNIV3_ROUTER02_CANONICAL,
      factory: UNIV3_FACTORY_CANONICAL,
      quoter: UNIV3_QUOTER_V2_CANONICAL,
      feeTiers: UNIV3_FEE_TIERS,
    },
    {
      id: 'uniswap-v2',
      label: 'Uniswap V2',
      kind: 'univ2',
      router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      feeBps: 30,
    },
    {
      id: 'sushiswap-v2',
      label: 'SushiSwap V2',
      kind: 'univ2',
      router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
      feeBps: 30,
    },
  ],
  pairs: [
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WETH', 'DAI'],
    ['WETH', 'WBTC'],
    ['USDC', 'USDT'],
    ['USDC', 'DAI'],
  ],
};

const REGISTRY: Record<ChainName, ChainConfig> = {
  base: BASE,
  arbitrum: ARBITRUM,
  ethereum: ETHEREUM,
};

export function getChain(name: ChainName): ChainConfig {
  const chain = REGISTRY[name];
  if (!chain) throw new Error(`Unknown chain: ${name}`);
  return chain;
}

export function tokenBySymbol(chain: ChainConfig, symbol: string): TokenInfo {
  const token = chain.tokens.find((t) => t.symbol === symbol);
  if (!token) throw new Error(`Token ${symbol} not configured on ${chain.name}`);
  return token;
}

/** Aave V3 charges 5 bps on flash loans; Balancer V2 charges nothing. */
export const AAVE_FLASH_FEE_BPS = 5;
export const BALANCER_FLASH_FEE_BPS = 0;
