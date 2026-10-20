// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MemeLaunchpad} from "../src/MemeLaunchpad.sol";
import {MemeToken} from "../src/MemeToken.sol";
import {CurveRef, LaunchpadBase} from "./LaunchpadBase.sol";

/// @notice Fuzz of the buy / sell / final-buy truncation math against the reference formulas.
contract MemeLaunchpadFuzzTest is LaunchpadBase {
    /// @dev Moves the curve to an arbitrary point: one buy (possibly none) and a partial sell.
    function _prime(uint256 preBuy, uint256 sellFrac) internal {
        preBuy = bound(preBuy, 0, 605e6);
        if (preBuy < 2) return;
        uint256 got = _buy(bob, token, preBuy);
        uint256 amount = got * bound(sellFrac, 0, 99) / 100;
        if (amount == 0) return;
        try lp.quoteSell(token, amount) {
            _sell(bob, token, amount);
        } catch {}
    }

    function testFuzz_buy_matchesReferenceQuoteAndBalances(
        uint256 preBuy,
        uint256 sellFrac,
        uint256 amountIn
    ) public {
        _prime(preBuy, sellFrac);
        amountIn = bound(amountIn, 1, 2000e6);
        (uint256 rOut, uint256 rUsed, uint256 rFee, bool rCompletes) = _refBuy(token, amountIn);
        usd.mint(alice, amountIn);
        vm.startPrank(alice);
        usd.approve(address(lp), amountIn);
        if (rUsed == rFee || rOut == 0) {
            vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
            lp.buy(token, amountIn, 0, block.timestamp, alice);
            vm.stopPrank();
            return;
        }
        vm.stopPrank();
        _quoteBuyMatchingRef(token, amountIn);
        MemeLaunchpad.CurveState memory s0 = _state(token);
        uint256 fees0 = lp.creatorFees(token) + lp.protocolFees();

        vm.prank(alice);
        assertEq(lp.buy(token, amountIn, rOut, block.timestamp, alice), rOut);
        assertEq(usd.balanceOf(alice), amountIn - rUsed);
        assertEq(MemeToken(token).balanceOf(alice), rOut);
        MemeLaunchpad.CurveState memory s1 = _state(token);
        assertEq(s1.virtualQuote - s0.virtualQuote, rUsed - rFee);
        assertEq(s0.virtualToken - s1.virtualToken, rOut);
        assertEq(lp.creatorFees(token) + lp.protocolFees() - fees0, rFee);
        assertEq(s1.status == MemeLaunchpad.Status.Completed, rCompletes);
        assertGe(s1.virtualQuote * s1.virtualToken, K);
    }

    function testFuzz_sell_matchesReferenceQuoteAndBalances(
        uint256 preBuy,
        uint256 sellFrac,
        uint256 buyIn,
        uint256 amount
    ) public {
        _prime(preBuy, sellFrac);
        buyIn = bound(buyIn, 2, _completionCost(token) - 1);
        uint256 held = _buy(alice, token, buyIn);
        amount = bound(amount, 1, held);
        (uint256 rOut, uint256 rFee) = _refSell(token, amount);
        if (rOut == 0) {
            vm.prank(alice);
            vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
            lp.sell(token, amount, 0, block.timestamp, alice);
            return;
        }
        _quoteSellMatchingRef(token, amount);
        MemeLaunchpad.CurveState memory s0 = _state(token);
        uint256 fees0 = lp.creatorFees(token) + lp.protocolFees();

        vm.prank(alice);
        assertEq(lp.sell(token, amount, rOut, block.timestamp, alice), rOut);
        assertEq(usd.balanceOf(alice), rOut);
        assertEq(MemeToken(token).balanceOf(alice), held - amount);
        MemeLaunchpad.CurveState memory s1 = _state(token);
        assertEq(s0.virtualQuote - s1.virtualQuote, rOut + rFee);
        assertEq(lp.creatorFees(token) + lp.protocolFees() - fees0, rFee);
        assertGe(s1.virtualQuote * s1.virtualToken, K);
    }

    /// The completing buy: `amountInUsed <= amountIn`, minimal, books exactly `netNeeded`, and
    /// delivers exactly the remainder.
    function testFuzz_truncation_boundedMinimalAndExact(
        uint256 preBuy,
        uint256 sellFrac,
        uint256 extra
    ) public {
        _prime(preBuy, sellFrac);
        uint256 netNeeded = CurveRef.ceilDiv(K, VT_END) - _state(token).virtualQuote;
        assertGe(netNeeded, 1); // never a free remainder
        uint256 cost = CurveRef.grossFor(netNeeded, FEE_BPS);
        uint256 amountIn = cost + bound(extra, 0, 1e15);
        uint256 remaining = _remaining(token);

        (uint256 out, uint256 used, uint256 fee, bool completes) =
            _quoteBuyMatchingRef(token, amountIn);
        assertTrue(completes);
        assertEq(used, cost);
        assertLe(used, amountIn);
        assertEq(used - fee, netNeeded);
        assertEq(out, remaining);
        (,,, bool below) = lp.quoteBuy(token, cost - 1);
        assertFalse(below); // one unit less does not complete

        uint256 lpUsd0 = usd.balanceOf(address(lp));
        assertEq(_buy(alice, token, amountIn), out);
        assertEq(usd.balanceOf(alice), amountIn - used);
        assertEq(usd.balanceOf(address(lp)) - lpUsd0, used);
        assertEq(MemeToken(token).balanceOf(alice), remaining);
        MemeLaunchpad.CurveState memory s = _state(token);
        assertEq(s.sold, CURVE);
        assertEq(
            usd.balanceOf(address(lp)), s.realQuote + lp.creatorFees(token) + lp.protocolFees()
        );
    }

    /// Premise check of the design's final-buy formula: the closed form is already the smallest
    /// x with x - ceil(x * fee) >= netNeeded, and it books exactly netNeeded (no "+1" step).
    function testFuzz_truncation_closedFormIsMinimalAndExact(uint256 netNeeded, uint256 feeBps)
        public
        pure
    {
        netNeeded = bound(netNeeded, 0, 1e40);
        feeBps = bound(feeBps, 0, 9999);
        uint256 x0 = CurveRef.ceilDiv(netNeeded * 10_000, 10_000 - feeBps);
        assertEq(x0 - CurveRef.fee(x0, feeBps), netNeeded);
        if (x0 > 0) assertLt(x0 - 1 - CurveRef.fee(x0 - 1, feeBps), netNeeded);
        assertEq(CurveRef.grossFor(netNeeded, feeBps), x0);
    }

    /// C2 as a fuzz: buy, then sell everything in up to four pieces; never more than paid.
    function testFuzz_roundTrip_neverProfits(
        uint256 preBuy,
        uint256 sellFrac,
        uint256 amountIn,
        uint256 pieces
    ) public {
        _prime(preBuy, sellFrac);
        amountIn = bound(amountIn, 2, _completionCost(token) - 1);
        pieces = bound(pieces, 1, 4);
        uint256 held = _buy(alice, token, amountIn);
        uint256 received;
        for (uint256 i; i < pieces; ++i) {
            uint256 amount = i + 1 == pieces ? MemeToken(token).balanceOf(alice) : held / pieces;
            vm.prank(alice);
            try lp.sell(token, amount, 0, block.timestamp, alice) returns (uint256 out) {
                received += out;
            } catch {}
        }
        assertLe(received, amountIn);
    }
}
