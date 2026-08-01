/**
 * Contract ABIs, trimmed to only the functions ARBO calls.
 */

export const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
] as const;

export const UNIV2_FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
] as const;

export const UNIV2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
] as const;

export const UNIV3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
] as const;

/**
 * QuoterV2. Note that `quoteExactInputSingle` is declared non-view because it
 * reverts internally to unwind state, so it must be invoked with staticCall.
 */
export const UNIV3_QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
] as const;

export const UNIV3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
] as const;

export const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

/**
 * Solidly-family factory (Aerodrome PoolFactory, Velodrome V2).
 *
 * `getPool` takes a `stable` flag because a pair can have both a stable and a
 * volatile pool at once, holding different prices.
 */
export const SOLIDLY_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address pool)',
  'function getFee(address pool, bool stable) view returns (uint256)',
] as const;

/**
 * Solidly-family pool.
 *
 * `getAmountOut` is the pool's own quote and is the authority ARBO's local port of
 * the stable curve is verified against — see `npm run verify:solidly`.
 */
export const SOLIDLY_POOL_ABI = [
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function getAmountOut(uint256 amountIn, address tokenIn) view returns (uint256)',
  'function stable() view returns (bool)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
] as const;

/**
 * Curve StableSwap.
 *
 * Quoted on-chain rather than ported locally. Unlike Solidly's single curve,
 * Curve has many pool implementations — plain, lending, metapool, crypto, and the
 * newer `-ng` variants — whose maths and even coin-index types differ. `get_dy`
 * is the one function common to all of them, and it is exact by construction,
 * which is worth more here than the local-pricing speed a port would buy.
 *
 * Older pools declare the indices as `int128`, newer ones as `uint256`; both
 * signatures are tried at discovery and whichever answers is remembered.
 */
export const CURVE_POOL_INT128_ABI = [
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function coins(uint256 i) view returns (address)',
  'function fee() view returns (uint256)',
] as const;

export const CURVE_POOL_UINT_ABI = [
  'function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)',
  'function coins(uint256 i) view returns (address)',
  'function fee() view returns (uint256)',
] as const;

/** ArboFlashArb — must stay in sync with contracts/ArboFlashArb.sol. */
export const ARBO_FLASH_ARB_ABI = [
  'function executeArb(uint8 provider, address asset, uint256 amount, (address router, uint8 kind, address tokenIn, address tokenOut, uint24 feeTier, int128 curveI, int128 curveJ)[] swaps, uint256 minProfit) external',
  'function owner() view returns (address)',
  'function rescueTokens(address token, address to, uint256 amount) external',
  'function AAVE_POOL() view returns (address)',
  'function BALANCER_VAULT() view returns (address)',
  'event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit)',
] as const;
