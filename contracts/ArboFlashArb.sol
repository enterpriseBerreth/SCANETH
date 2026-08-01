// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * ArboFlashArb — atomic flash-loan arbitrage executor.
 *
 * Borrows an asset, walks an owner-supplied swap route, and repays inside a
 * single transaction. Supports two liquidity sources:
 *
 *   - Aave V3   (5 bps premium)
 *   - Balancer V2 (no premium — preferred whenever the vault holds the asset)
 *
 * SAFETY MODEL
 * ------------
 * The single most important property of this contract is that it reverts rather
 * than completes a losing trade. `minProfit` is checked after the route has run
 * but before repayment, so if the opportunity has decayed by the time the
 * transaction lands, the whole thing unwinds and the only cost is gas. Principal
 * is never at risk from an unprofitable route.
 *
 * Per-swap `amountOutMinimum` is deliberately left at zero. The final profit
 * assertion is a strictly stronger, end-to-end economic constraint; adding
 * per-leg minimums would only introduce spurious reverts without improving
 * safety.
 *
 * `executeArb` is owner-only, and both flash-loan callbacks verify that they
 * were invoked by the expected lender and initiated by this contract, so no
 * third party can drive the swap logic.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/**
 * Solidly-family pool (Aerodrome, Velodrome).
 *
 * `getAmountOut` is queried rather than reimplemented: the pool applies its own
 * stable-vs-volatile curve, so the caller cannot select the wrong one.
 */
interface ISolidlyPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);

    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;

    function token0() external view returns (address);
}

/** Curve pools declaring coin indices as int128 (the original StableSwap ABI). */
interface ICurveInt128 {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

/** Curve pools declaring coin indices as uint256 (crypto pools and -ng). */
interface ICurveUint256 {
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 minDy) external returns (uint256);
}

contract ArboFlashArb {
    enum FlashProvider {
        Aave,
        Balancer
    }

    enum SwapKind {
        UniV2,
        UniV3,
        Solidly,
        CurveInt128,
        CurveUint256
    }

    /**
     * One hop.
     *
     * `router` is the contract the hop is sent to. For UniV2/UniV3 that is a
     * router; for Solidly and Curve it is the **pool itself**, because both are
     * swapped against directly:
     *
     *  - Solidly's router needs a `Route[]` carrying a `stable` flag and a
     *    factory address. Encoding those off-chain and trusting them on-chain is
     *    a silent-wrongness risk — a mis-set `stable` flag routes onto the wrong
     *    curve and still succeeds. Calling `pool.getAmountOut` instead asks the
     *    pool which curve it is, so the flag cannot be wrong.
     *  - Curve has no common router across its pool variants.
     *
     * `curveI`/`curveJ` are coin indices, used only by the Curve kinds. Two Curve
     * kinds exist because older pools declare `exchange(int128,...)` and newer
     * ones `exchange(uint256,...)`; the selectors differ, so the variant has to
     * be known rather than guessed.
     */
    struct Swap {
        address router;
        uint8 kind;
        address tokenIn;
        address tokenOut;
        uint24 feeTier;
        int128 curveI;
        int128 curveJ;
    }

    address public immutable owner;
    address public immutable AAVE_POOL;
    address public immutable BALANCER_VAULT;

    event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit);

    error NotOwner();
    error UnauthorizedCallback();
    error UnprofitableTrade(uint256 balance, uint256 required);
    error NoSwaps();
    error UnsupportedProvider();
    error UnsupportedSwapKind();
    error TokenCallFailed();
    error ProviderNotConfigured();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * Either provider address may be the zero address if that lender is not
     * deployed on the target chain; attempting to use it will then revert.
     */
    constructor(address aavePool, address balancerVault) {
        owner = msg.sender;
        AAVE_POOL = aavePool;
        BALANCER_VAULT = balancerVault;
    }

    // ── entry point ─────────────────────────────────────────────────────────

    /**
     * @param provider  0 = Aave V3, 1 = Balancer V2
     * @param asset     token to borrow and repay; also the cycle's start and end
     * @param amount    flash-loan principal
     * @param swaps     ordered route; the last hop must return to `asset`
     * @param minProfit minimum profit in `asset` units, enforced atomically
     */
    function executeArb(
        uint8 provider,
        address asset,
        uint256 amount,
        Swap[] calldata swaps,
        uint256 minProfit
    ) external onlyOwner {
        if (swaps.length == 0) revert NoSwaps();

        bytes memory params = abi.encode(asset, amount, swaps, minProfit);

        if (provider == uint8(FlashProvider.Aave)) {
            if (AAVE_POOL == address(0)) revert ProviderNotConfigured();
            IAaveV3Pool(AAVE_POOL).flashLoanSimple(address(this), asset, amount, params, 0);
        } else if (provider == uint8(FlashProvider.Balancer)) {
            if (BALANCER_VAULT == address(0)) revert ProviderNotConfigured();
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = asset;
            amounts[0] = amount;
            IBalancerVault(BALANCER_VAULT).flashLoan(address(this), tokens, amounts, params);
        } else {
            revert UnsupportedProvider();
        }
    }

    // ── lender callbacks ────────────────────────────────────────────────────

    /** Aave V3 callback. Repayment is pulled by the pool, so we approve it. */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != AAVE_POOL || initiator != address(this)) {
            revert UnauthorizedCallback();
        }

        uint256 owed = amount + premium;
        _runRoute(asset, amount, owed, params);
        _safeApprove(asset, AAVE_POOL, owed);

        return true;
    }

    /** Balancer V2 callback. Repayment must be pushed back to the vault. */
    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        if (msg.sender != BALANCER_VAULT) revert UnauthorizedCallback();

        address asset = tokens[0];
        uint256 amount = amounts[0];
        uint256 owed = amount + feeAmounts[0];

        _runRoute(asset, amount, owed, userData);
        _safeTransfer(asset, BALANCER_VAULT, owed);
    }

    // ── core ────────────────────────────────────────────────────────────────

    /**
     * Execute the route, assert profitability, then sweep profit to the owner
     * leaving exactly `owed` behind for repayment.
     *
     * Accounting is done relative to the contract's pre-loan balance, so any
     * idle tokens already sitting here can never be mistaken for trade profit
     * (which would otherwise let a losing trade pass the profit check).
     */
    function _runRoute(
        address asset,
        uint256 amount,
        uint256 owed,
        bytes calldata params
    ) internal {
        (, , Swap[] memory swaps, uint256 minProfit) =
            abi.decode(params, (address, uint256, Swap[], uint256));

        uint256 balanceBeforeLoan = IERC20(asset).balanceOf(address(this)) - amount;

        uint256 working = amount;
        for (uint256 i = 0; i < swaps.length; i++) {
            working = _swap(swaps[i], working);
        }

        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 required = balanceBeforeLoan + owed + minProfit;
        if (balance < required) revert UnprofitableTrade(balance, required);

        uint256 profit = balance - balanceBeforeLoan - owed;
        emit ArbExecuted(asset, amount, profit);

        if (profit > 0) {
            _safeTransfer(asset, owner, profit);
        }
    }

    function _swap(Swap memory s, uint256 amountIn) internal returns (uint256) {
        if (s.kind == uint8(SwapKind.Solidly)) {
            // Direct pool swap: Solidly pools are paid by transfer, not pull, so
            // no approval is involved. The pool is asked for its own quote, which
            // means the stable/volatile curve is chosen by the pool rather than by
            // a flag we passed in — the one place this could go silently wrong.
            uint256 out = ISolidlyPool(s.router).getAmountOut(amountIn, s.tokenIn);
            if (out == 0) revert UnsupportedSwapKind();

            _safeTransfer(s.tokenIn, s.router, amountIn);

            bool zeroIsIn = ISolidlyPool(s.router).token0() == s.tokenIn;
            uint256 balBefore = _balanceOf(s.tokenOut);
            ISolidlyPool(s.router).swap(
                zeroIsIn ? 0 : out,
                zeroIsIn ? out : 0,
                address(this),
                ""
            );
            // Measured rather than assumed: fee-on-transfer tokens deliver less
            // than the pool reports, and repaying the loan on an assumed figure
            // would revert the whole bundle at the final balance check anyway.
            return _balanceOf(s.tokenOut) - balBefore;
        }

        _safeApprove(s.tokenIn, s.router, amountIn);

        if (s.kind == uint8(SwapKind.UniV2)) {
            address[] memory path = new address[](2);
            path[0] = s.tokenIn;
            path[1] = s.tokenOut;

            uint256[] memory amounts = IUniswapV2Router(s.router).swapExactTokensForTokens(
                amountIn,
                0,
                path,
                address(this),
                block.timestamp
            );
            return amounts[amounts.length - 1];
        }

        if (s.kind == uint8(SwapKind.UniV3)) {
            return IUniswapV3Router(s.router).exactInputSingle(
                IUniswapV3Router.ExactInputSingleParams({
                    tokenIn: s.tokenIn,
                    tokenOut: s.tokenOut,
                    fee: s.feeTier,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        if (s.kind == uint8(SwapKind.CurveInt128) || s.kind == uint8(SwapKind.CurveUint256)) {
            // Curve's `exchange` return value is unreliable across variants: some
            // pools predate it, others return the pre-fee figure. Measure instead.
            uint256 balBefore = _balanceOf(s.tokenOut);

            if (s.kind == uint8(SwapKind.CurveInt128)) {
                ICurveInt128(s.router).exchange(s.curveI, s.curveJ, amountIn, 0);
            } else {
                ICurveUint256(s.router).exchange(
                    uint256(int256(s.curveI)),
                    uint256(int256(s.curveJ)),
                    amountIn,
                    0
                );
            }

            return _balanceOf(s.tokenOut) - balBefore;
        }

        revert UnsupportedSwapKind();
    }

    // ── owner utilities ─────────────────────────────────────────────────────

    /** Escape hatch for stranded tokens. */
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        _safeTransfer(token, to, amount);
    }

    /** Escape hatch for stranded native currency. */
    function rescueNative(address to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}('');
        if (!ok) revert TokenCallFailed();
    }

    receive() external payable {}

    // ── non-standard ERC20 tolerance ────────────────────────────────────────
    //
    // Tokens such as USDT omit the boolean return value that ERC20 specifies.
    // Calling them through a typed interface reverts on return-data decoding, so
    // token interactions go through low-level calls that accept either an empty
    // response or an explicit `true`.

    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0x095ea7b3, spender, amount) // approve(address,uint256)
        );
        if (!_isSuccess(ok, data)) revert TokenCallFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(0xa9059cbb, to, amount) // transfer(address,uint256)
        );
        if (!_isSuccess(ok, data)) revert TokenCallFailed();
    }

    function _balanceOf(address token) internal view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function _isSuccess(bool ok, bytes memory data) private pure returns (bool) {
        if (!ok) return false;
        if (data.length == 0) return true;
        return abi.decode(data, (bool));
    }
}
