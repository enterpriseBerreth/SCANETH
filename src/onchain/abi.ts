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

/** ArboFlashArb — must stay in sync with contracts/ArboFlashArb.sol. */
export const ARBO_FLASH_ARB_ABI = [
  'function executeArb(uint8 provider, address asset, uint256 amount, (address router, uint8 kind, address tokenIn, address tokenOut, uint24 feeTier)[] swaps, uint256 minProfit) external',
  'function owner() view returns (address)',
  'function rescueTokens(address token, address to, uint256 amount) external',
  'function AAVE_POOL() view returns (address)',
  'function BALANCER_VAULT() view returns (address)',
  'event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit)',
] as const;
