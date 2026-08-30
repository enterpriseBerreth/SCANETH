/**
 * SCANETH on-chain constants.
 *
 * All addresses are Ethereum mainnet deployments. SCANETH is intentionally
 * single-chain: new-token risk analysis is most valuable on the chain with the
 * deepest liquidity and the most active launch market.
 */

export const ETHEREUM = {
  chainId: 1,
  name: 'ethereum',
  nativeSymbol: 'ETH',
  wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
} as const;

/** Common quote assets on Ethereum. Pairs containing these are candidate launches. */
export const QUOTE_TOKENS = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
]);

/** ERC-20 event and function signatures. */
export const ERC20 = {
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  Approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
} as const;

/** Contract creation is a transfer from the zero address with no topics. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Dead / burn addresses used as a proxy for LP lock/burn. */
export const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x0000000000000000000000000000000000000001',
  '0x000000000000000000000000000000000000000d',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069',
]);

/** Factory deployments we watch for new pairs/pools. */
export const DEX_FACTORIES = {
  'uniswap-v2': {
    address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    /** PairCreated(address indexed token0, address indexed token1, address pair, uint256) */
    topic: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e7',
  },
  'sushiswap-v2': {
    address: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    topic: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e7',
  },
  'uniswap-v3': {
    address: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    /** PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool) */
    topic: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  },
} as const;

/** Block look-back window for pairing liquidity events with contract creation. */
export const LIQUIDITY_PAIRING_BLOCKS = 3;

/** ERC-20 bytecode red flags used by the static analyzer. */
export const RISK_PATTERNS = [
  {
    key: 'selfdestruct',
    label: 'Contract contains SELFDESTRUCT / DELEGATECALL bomb risk',
    points: 25,
    critical: false,
    hex: '0xff',
  },
  {
    key: 'blacklist_function',
    label: 'Blacklist / blocklist function selector detected',
    points: 20,
    critical: false,
    hex: '0x3ec54e',
  },
  {
    key: 'mint_function_unguarded',
    label: 'Unguarded mint function selector present',
    points: 30,
    critical: true,
    hex: '0x40c10f19',
  },
  {
    key: 'pause_function',
    label: 'Pausable function selector detected',
    points: 15,
    critical: false,
    hex: '0x8456cb59',
  },
  {
    key: 'approve_rug',
    label: 'Forced approve / arbitrary spend helper detected',
    points: 20,
    critical: false,
    hex: '0x095ea7b3',
  },
  {
    key: 'hidden_mint',
    label: 'Hidden mint via internal _mint not guarded by constructor',
    points: 25,
    critical: true,
    hex: '0x4e6ce0e1',
  },
] as const;

/** Risk score thresholds. */
export const RISK_TIERS = {
  low: { max: 20, label: 'low' as const },
  medium: { max: 45, label: 'medium' as const },
  high: { max: 75, label: 'high' as const },
  critical: { max: 100, label: 'critical' as const },
};
