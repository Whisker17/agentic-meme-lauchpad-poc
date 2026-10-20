// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {MockUSD} from "mantle-7702-sdk/src/mocks/MockUSD.sol";
import {MemeLaunchpad} from "../src/MemeLaunchpad.sol";
import {MemeToken} from "../src/MemeToken.sol";

/// @notice The normative curve formulas of the design, written independently of the contract
///         (own rounding, and the final-buy search including its "+1 while it fails" step).
library CurveRef {
    uint256 internal constant BPS = 10_000;

    function ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function fee(uint256 amount, uint256 feeBps) internal pure returns (uint256) {
        return ceilDiv(amount * feeBps, BPS);
    }

    /// @dev The smallest x with x - fee(x) >= netNeeded: closed form, then +1 while it fails.
    function grossFor(uint256 netNeeded, uint256 feeBps) internal pure returns (uint256 x) {
        x = ceilDiv(netNeeded * BPS, BPS - feeBps);
        while (x - fee(x, feeBps) < netNeeded) ++x;
    }

    function buy(uint256 vT, uint256 vQ, uint256 k, uint256 vTEnd, uint256 feeBps, uint256 amountIn)
        internal
        pure
        returns (uint256 out, uint256 used, uint256 feeUsed, bool completes)
    {
        used = amountIn;
        feeUsed = fee(amountIn, feeBps);
        out = vT - ceilDiv(k, vQ + used - feeUsed);
        uint256 r = vT - vTEnd;
        if (out >= r) {
            used = grossFor(ceilDiv(k, vTEnd) - vQ, feeBps);
            feeUsed = fee(used, feeBps);
            out = r;
            completes = true;
        }
    }

    function sell(uint256 vT, uint256 vQ, uint256 k, uint256 feeBps, uint256 amount)
        internal
        pure
        returns (uint256 out, uint256 feeTaken)
    {
        uint256 gross = vQ - ceilDiv(k, vT + amount);
        feeTaken = fee(gross, feeBps);
        out = gross - feeTaken;
    }
}

/// @notice Deploys MockUSD and a launchpad with the design's §4.2 parameters, plus one token.
abstract contract LaunchpadBase is Test {
    uint256 internal constant TOTAL = 1_000_000_000e18;
    uint256 internal constant CURVE = 800_000_000e18;
    uint256 internal constant RESERVED = TOTAL - CURVE;
    uint256 internal constant VT0 = 1_066_666_667e18;
    uint256 internal constant VQ0 = 200e6;
    uint256 internal constant FEE_BPS = 100;
    uint256 internal constant K = VT0 * VQ0;
    uint256 internal constant VT_END = VT0 - CURVE;

    MockUSD internal usd;
    MemeLaunchpad internal lp;
    address internal token;
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    function setUp() public virtual {
        usd = new MockUSD();
        lp = new MemeLaunchpad(address(usd), treasury, params());
        token = _create(creator, "salt");
    }

    function params() internal pure returns (MemeLaunchpad.CurveParams memory) {
        return MemeLaunchpad.CurveParams({
            totalSupply: TOTAL,
            curveSupply: CURVE,
            virtualToken0: VT0,
            virtualQuote0: VQ0,
            feeBps: FEE_BPS
        });
    }

    function _create(address who, bytes32 salt) internal returns (address t) {
        vm.prank(who);
        t = lp.createToken("Pepe", "PEPE", "a frog", "https://img", salt);
    }

    /// @dev Mints and approves exactly `amountIn`, then buys for `who` into `who`.
    function _buy(address who, address t, uint256 amountIn) internal returns (uint256 out) {
        usd.mint(who, amountIn);
        vm.startPrank(who);
        usd.approve(address(lp), amountIn);
        out = lp.buy(t, amountIn, 0, block.timestamp, who);
        vm.stopPrank();
    }

    function _sell(address who, address t, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        out = lp.sell(t, amount, 0, block.timestamp, who);
    }

    function _state(address t) internal view returns (MemeLaunchpad.CurveState memory) {
        return lp.curveState(t);
    }

    function _remaining(address t) internal view returns (uint256) {
        return _state(t).virtualToken - VT_END;
    }

    /// @dev Quote that completes the curve of `t` now (the truncated `amountInUsed`).
    function _completionCost(address t) internal view returns (uint256 used) {
        (, used,,) = lp.quoteBuy(t, type(uint128).max);
    }

    function _refBuy(address t, uint256 amountIn)
        internal
        view
        returns (uint256 out, uint256 used, uint256 feeUsed, bool completes)
    {
        MemeLaunchpad.CurveState memory s = _state(t);
        return CurveRef.buy(s.virtualToken, s.virtualQuote, K, VT_END, FEE_BPS, amountIn);
    }

    /// @dev `quoteBuy`, asserted equal to the reference formulas.
    function _quoteBuyMatchingRef(address t, uint256 amountIn)
        internal
        view
        returns (uint256 out, uint256 used, uint256 feeUsed, bool completes)
    {
        (out, used, feeUsed, completes) = lp.quoteBuy(t, amountIn);
        (uint256 rOut, uint256 rUsed, uint256 rFee, bool rCompletes) = _refBuy(t, amountIn);
        assertEq(out, rOut, "quoteBuy out");
        assertEq(used, rUsed, "quoteBuy amountInUsed");
        assertEq(feeUsed, rFee, "quoteBuy feeUsed");
        assertEq(completes, rCompletes, "quoteBuy completes");
    }

    function _quoteSellMatchingRef(address t, uint256 amount)
        internal
        view
        returns (uint256 out, uint256 f)
    {
        (out, f) = lp.quoteSell(t, amount);
        (uint256 rOut, uint256 rFee) = _refSell(t, amount);
        assertEq(out, rOut, "quoteSell out");
        assertEq(f, rFee, "quoteSell fee");
    }

    function _refSell(address t, uint256 amount) internal view returns (uint256 out, uint256 f) {
        MemeLaunchpad.CurveState memory s = _state(t);
        return CurveRef.sell(s.virtualToken, s.virtualQuote, K, FEE_BPS, amount);
    }
}
