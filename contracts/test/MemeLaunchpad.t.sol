// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ILaunchpad} from "mantle-7702-sdk/src/interfaces/ILaunchpad.sol";
import {MemeLaunchpad} from "../src/MemeLaunchpad.sol";
import {MemeToken} from "../src/MemeToken.sol";
import {CurveRef, LaunchpadBase} from "./LaunchpadBase.sol";

contract MemeLaunchpadTest is LaunchpadBase {
    // ------------------------------------------------------------------ ABI

    function test_selectors_matchTheHookAbi() public pure {
        assertEq(MemeLaunchpad.buy.selector, bytes4(0x9f01c7de));
        assertEq(MemeLaunchpad.sell.selector, bytes4(0x1d87be21));
        assertEq(ILaunchpad.buy.selector, bytes4(0x9f01c7de));
        assertEq(ILaunchpad.sell.selector, bytes4(0x1d87be21));
        assertEq(
            MemeLaunchpad.createToken.selector,
            bytes4(keccak256("createToken(string,string,string,string,bytes32)"))
        );
        assertEq(
            MemeLaunchpad.claimCreatorFees.selector, bytes4(keccak256("claimCreatorFees(address)"))
        );
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_setsImmutables() public view {
        assertEq(lp.quoteToken(), address(usd));
        assertEq(lp.treasury(), treasury);
        assertEq(lp.TOTAL_SUPPLY(), TOTAL);
        assertEq(lp.CURVE_SUPPLY(), CURVE);
        assertEq(lp.VIRTUAL_TOKEN_0(), VT0);
        assertEq(lp.VIRTUAL_QUOTE_0(), VQ0);
        assertEq(lp.FEE_BPS(), FEE_BPS);
        assertEq(lp.K(), K);
    }

    function test_constructor_rejectsInvalidParams() public {
        MemeLaunchpad.CurveParams memory p = params();
        vm.expectRevert(MemeLaunchpad.InvalidParams.selector);
        new MemeLaunchpad(address(0), treasury, p);
        vm.expectRevert(MemeLaunchpad.InvalidParams.selector);
        new MemeLaunchpad(address(usd), address(0), p);

        p.curveSupply = 0;
        _expectInvalid(p);
        p = params();
        p.curveSupply = TOTAL + 1;
        _expectInvalid(p);
        p = params();
        p.virtualToken0 = CURVE;
        _expectInvalid(p);
        p = params();
        p.virtualQuote0 = 0;
        _expectInvalid(p);
        p = params();
        p.feeBps = 10_000;
        _expectInvalid(p);
    }

    function _expectInvalid(MemeLaunchpad.CurveParams memory p) internal {
        vm.expectRevert(MemeLaunchpad.InvalidParams.selector);
        new MemeLaunchpad(address(usd), treasury, p);
    }

    // ------------------------------------------------------------------ §4.2 curve numbers

    function test_curveNumbers_startPriceFillAndMultiple() public {
        MemeLaunchpad.CurveState memory s = _state(token);
        assertEq(s.virtualToken, VT0);
        assertEq(s.virtualQuote, 200e6);
        // ≈1.875e-7 mUSD per token = 0.1875 quote base units per whole token (FDV ≈ 187.5 mUSD).
        uint256 startPrice = s.virtualQuote * 1e36 / s.virtualToken; // base units per token, 1e18
        assertApproxEqRel(startPrice, 0.1875e18, 1e12);
        assertApproxEqRel(startPrice * (TOTAL / 1e18) / 1e18, 187.5e6, 1e12);
        // The canonical `priceE18 = vQ * 1e18 / vT` (integer) at launch.
        assertEq(s.priceE18, s.virtualQuote * 1e18 / s.virtualToken);

        // Filling the curve takes 600 mUSD net of fees (606.06 mUSD with the 1% fee).
        (uint256 out, uint256 used, uint256 fee, bool completes) =
            lp.quoteBuy(token, type(uint128).max);
        assertTrue(completes);
        assertEq(out, CURVE);
        assertEq(used - fee, 600e6);
        assertEq(used, 606_060_607);
        assertEq(fee, 6_060_607);
        _buy(alice, token, used);

        s = _state(token);
        assertEq(s.virtualToken, 266_666_667e18);
        assertEq(s.virtualQuote, 800e6);
        assertEq(s.realQuote, 600e6);
        assertEq(s.sold, CURVE);
        assertEq(uint8(s.status), uint8(MemeLaunchpad.Status.Completed));
        uint256 endPrice = s.virtualQuote * 1e36 / s.virtualToken;
        assertApproxEqRel(endPrice * 1e18 / startPrice, 16e18, 1e11); // ×16
        assertApproxEqRel(endPrice * (TOTAL / 1e18) / 1e18, 3000e6, 1e11); // FDV ≈ 3,000 mUSD
    }

    // ------------------------------------------------------------------ createToken

    function test_createToken_registersMintsToLaunchpadAndEmits() public {
        bytes32 salt = "pepe2";
        address predicted = lp.predictTokenAddress(alice, salt, "Pepe", "PEPE");
        vm.expectEmit(address(lp));
        emit MemeLaunchpad.TokenCreated(
            predicted, alice, "Pepe", "PEPE", "a frog", "https://img", salt
        );
        vm.warp(1234);
        address t = _create(alice, salt);
        assertEq(t, predicted);

        MemeToken m = MemeToken(t);
        assertEq(m.launchpad(), address(lp));
        assertEq(m.totalSupply(), TOTAL);
        assertEq(m.balanceOf(address(lp)), TOTAL);
        assertEq(m.balanceOf(alice), 0);
        assertEq(m.decimals(), 18);
        assertEq(m.name(), "Pepe");
        assertEq(m.symbol(), "PEPE");

        MemeLaunchpad.CurveState memory s = _state(t);
        assertEq(s.creator, alice);
        assertEq(s.createdAt, 1234);
        assertEq(uint8(s.status), uint8(MemeLaunchpad.Status.Trading));
        assertEq(s.sold, 0);
        assertEq(s.realQuote, 0);
        assertTrue(lp.isRegistered(t));
        assertEq(lp.tokenCount(), 2);
        assertEq(usd.balanceOf(address(lp)), 0); // free
    }

    function testFuzz_predictTokenAddress_matchesCreate(
        address who,
        bytes32 salt,
        string calldata name,
        string calldata symbol
    ) public {
        vm.assume(who != address(0));
        address predicted = lp.predictTokenAddress(who, salt, name, symbol);
        vm.prank(who);
        assertEq(lp.createToken(name, symbol, "", "", salt), predicted);
    }

    function test_createToken_sameCreatorSameSaltCollides() public {
        vm.prank(creator);
        vm.expectRevert();
        lp.createToken("Pepe", "PEPE", "", "", "salt");
        // Another name/symbol is another init code, hence another address.
        vm.prank(creator);
        lp.createToken("Pepe2", "PEPE2", "", "", "salt");
    }

    function test_unknownToken_viewsAreEmpty() public view {
        assertFalse(lp.isRegistered(address(usd)));
        MemeLaunchpad.CurveState memory s = _state(address(usd));
        assertEq(uint8(s.status), uint8(MemeLaunchpad.Status.None));
        assertEq(s.virtualToken, 0);
        assertEq(lp.creatorFees(address(usd)), 0);
    }

    function test_tokens_paginates() public {
        address t2 = _create(alice, "a");
        address t3 = _create(bob, "b");
        assertEq(lp.tokenCount(), 3);
        address[] memory page = lp.tokens(0, 10);
        assertEq(page.length, 3);
        assertEq(page[0], token);
        assertEq(page[1], t2);
        assertEq(page[2], t3);
        page = lp.tokens(1, 1);
        assertEq(page.length, 1);
        assertEq(page[0], t2);
        assertEq(lp.tokens(2, type(uint256).max).length, 1);
        assertEq(lp.tokens(3, 5).length, 0);
        assertEq(lp.tokens(type(uint256).max, type(uint256).max).length, 0);
    }

    // ------------------------------------------------------------------ buy

    function test_buy_normalMatchesQuoteReferenceAndEvent() public {
        uint256 amountIn = 10e6;
        (uint256 qOut, uint256 qUsed, uint256 qFee, bool qCompletes) =
            _quoteBuyMatchingRef(token, amountIn);
        assertFalse(qCompletes);
        assertEq(qUsed, amountIn);
        assertEq(qFee, 100_000);

        usd.mint(alice, amountIn);
        vm.startPrank(alice);
        usd.approve(address(lp), amountIn);
        vm.expectEmit(address(lp));
        emit MemeLaunchpad.Trade(
            token, alice, alice, true, amountIn, qOut, qFee, VQ0 + amountIn - qFee, VT0 - qOut
        );
        assertEq(lp.buy(token, amountIn, qOut, block.timestamp, alice), qOut);
        vm.stopPrank();

        assertEq(MemeToken(token).balanceOf(alice), qOut);
        assertEq(usd.balanceOf(alice), 0);
        assertEq(usd.balanceOf(address(lp)), amountIn);
        assertEq(lp.creatorFees(token), 50_000);
        assertEq(lp.protocolFees(), 50_000);
        MemeLaunchpad.CurveState memory s = _state(token);
        assertEq(s.realQuote, amountIn - qFee);
        assertEq(s.sold, qOut);
        assertGe(s.virtualQuote * s.virtualToken, K);
    }

    function test_buy_rejects() public {
        usd.mint(alice, 1e6);
        vm.startPrank(alice);
        usd.approve(address(lp), 1e6);

        vm.expectRevert(MemeLaunchpad.UnknownToken.selector);
        lp.buy(address(usd), 1e6, 0, block.timestamp, alice);
        vm.expectRevert(MemeLaunchpad.ZeroAmount.selector);
        lp.buy(token, 0, 0, block.timestamp, alice);
        vm.expectRevert(MemeLaunchpad.Expired.selector);
        lp.buy(token, 1e6, 0, block.timestamp - 1, alice);
        (uint256 out,,,) = lp.quoteBuy(token, 1e6);
        vm.expectRevert(MemeLaunchpad.InsufficientOutput.selector);
        lp.buy(token, 1e6, out + 1, block.timestamp, alice);
        lp.buy(token, 1e6, out, block.timestamp, alice); // exactly minOut passes
        vm.stopPrank();
    }

    uint256 internal constant AMOUNT_IN = 700e6;

    /// The acceptance case: a truncated final buy pulls `amountInUsed`, books only
    /// `netUsed` / `feeUsed`, and `quoteBuy` returned the same values beforehand.
    function test_buy_truncatedFinalBuyPullsAmountInUsedAndBooksOnlyUsed() public {
        _buy(bob, token, 300e6);
        MemeLaunchpad.CurveState memory s0 = _state(token);
        uint256 cf0 = lp.creatorFees(token);
        uint256 pf0 = lp.protocolFees();

        (uint256 qOut, uint256 qUsed, uint256 qFee, bool qCompletes) =
            _quoteBuyMatchingRef(token, AMOUNT_IN);
        assertTrue(qCompletes);
        assertEq(qOut, s0.virtualToken - VT_END);
        assertLt(qUsed, AMOUNT_IN);
        uint256 netUsed = qUsed - qFee;
        assertEq(netUsed, CurveRef.ceilDiv(K, VT_END) - s0.virtualQuote); // = netNeeded

        usd.mint(alice, AMOUNT_IN);
        vm.startPrank(alice);
        usd.approve(address(lp), AMOUNT_IN);
        _expectCompletingBuyEvents(s0, qOut, qUsed, qFee);
        assertEq(lp.buy(token, AMOUNT_IN, qOut, block.timestamp, alice), qOut);
        vm.stopPrank();

        assertEq(usd.balanceOf(alice), AMOUNT_IN - qUsed); // pulled exactly amountInUsed
        assertEq(usd.allowance(alice, address(lp)), AMOUNT_IN - qUsed);
        assertEq(MemeToken(token).balanceOf(alice), s0.virtualToken - VT_END);
        MemeLaunchpad.CurveState memory s1 = _state(token);
        assertEq(s1.virtualQuote - s0.virtualQuote, netUsed);
        assertEq(s1.realQuote - s0.realQuote, netUsed);
        assertEq(lp.creatorFees(token) - cf0, qFee / 2);
        assertEq(lp.protocolFees() - pf0, qFee - qFee / 2);
        assertEq(s1.virtualToken, VT_END);
        assertEq(uint8(s1.status), uint8(MemeLaunchpad.Status.Completed));
        assertEq(usd.balanceOf(address(lp)), 300e6 + qUsed);
        assertEq(
            usd.balanceOf(address(lp)), s1.realQuote + lp.creatorFees(token) + lp.protocolFees()
        );
    }

    function _expectCompletingBuyEvents(
        MemeLaunchpad.CurveState memory s0,
        uint256 out,
        uint256 used,
        uint256 fee
    ) internal {
        uint256 netUsed = used - fee;
        vm.expectEmit(address(lp));
        emit MemeLaunchpad.Trade(
            token, alice, alice, true, used, out, fee, s0.virtualQuote + netUsed, VT_END
        );
        vm.expectEmit(address(lp));
        emit MemeLaunchpad.CurveCompleted(token, s0.realQuote + netUsed);
    }

    function test_buy_completionCostIsMinimal() public {
        _buy(bob, token, 123_456_789);
        uint256 cost = _completionCost(token);
        (,,, bool completes) = lp.quoteBuy(token, cost - 1);
        assertFalse(completes);
        (uint256 out,,, bool completesAtCost) = lp.quoteBuy(token, cost);
        assertTrue(completesAtCost);
        assertEq(out, _remaining(token));
        assertEq(_buy(alice, token, cost), out);
        assertEq(usd.balanceOf(alice), 0);
    }

    function test_buy_truncationChecksMinOutAgainstTruncatedOut() public {
        uint256 remaining = _remaining(token);
        usd.mint(alice, 1000e6);
        vm.startPrank(alice);
        usd.approve(address(lp), 1000e6);
        vm.expectRevert(MemeLaunchpad.InsufficientOutput.selector);
        lp.buy(token, 1000e6, remaining + 1, block.timestamp, alice);
        assertEq(lp.buy(token, 1000e6, remaining, block.timestamp, alice), remaining);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ sell

    function test_sell_matchesQuoteReferenceAndEvent() public {
        uint256 bought = _buy(alice, token, 50e6);
        uint256 amount = bought / 3;
        (uint256 qOut, uint256 qFee) = _quoteSellMatchingRef(token, amount);
        MemeLaunchpad.CurveState memory s0 = _state(token);
        uint256 cf0 = lp.creatorFees(token);
        uint256 pf0 = lp.protocolFees();

        vm.expectEmit(address(lp));
        emit MemeLaunchpad.Trade(
            token,
            alice,
            alice,
            false,
            qOut,
            amount,
            qFee,
            s0.virtualQuote - qOut - qFee,
            s0.virtualToken + amount
        );
        vm.prank(alice); // no approve: the launchpad moves the tokens itself
        assertEq(lp.sell(token, amount, qOut, block.timestamp, alice), qOut);

        assertEq(MemeToken(token).balanceOf(alice), bought - amount);
        assertEq(usd.balanceOf(alice), qOut);
        MemeLaunchpad.CurveState memory s1 = _state(token);
        assertEq(s0.realQuote - s1.realQuote, qOut + qFee);
        assertEq(lp.creatorFees(token) - cf0, qFee / 2);
        assertEq(lp.protocolFees() - pf0, qFee - qFee / 2);
    }

    function test_sell_rejects() public {
        uint256 bought = _buy(alice, token, 5e6);
        vm.startPrank(alice);
        vm.expectRevert(MemeLaunchpad.UnknownToken.selector);
        lp.sell(address(usd), bought, 0, block.timestamp, alice);
        vm.expectRevert(MemeLaunchpad.ZeroAmount.selector);
        lp.sell(token, 0, 0, block.timestamp, alice);
        vm.expectRevert(MemeLaunchpad.Expired.selector);
        lp.sell(token, bought, 0, block.timestamp - 1, alice);
        (uint256 out,) = lp.quoteSell(token, bought);
        vm.expectRevert(MemeLaunchpad.InsufficientOutput.selector);
        lp.sell(token, bought, out + 1, block.timestamp, alice);
        vm.stopPrank();
    }

    function test_sell_everyOutstandingTokenReturnsAtMostRealQuote() public {
        uint256 a = _buy(alice, token, 120e6);
        uint256 b = _buy(bob, token, 33e6);
        uint256 c = _buy(creator, token, 7e6);
        uint256 realQuote = _state(token).realQuote;
        uint256 paidOut = _sell(bob, token, b) + _sell(alice, token, a) + _sell(creator, token, c);
        assertLe(paidOut, realQuote);
        MemeLaunchpad.CurveState memory s = _state(token);
        assertEq(s.sold, 0);
        assertEq(s.realQuote, 0); // gross of all sells telescopes to exactly realQuote
        assertEq(usd.balanceOf(address(lp)), lp.creatorFees(token) + lp.protocolFees());
    }

    // ------------------------------------------------------------------ lifecycle

    function test_lifecycle_completedStopsBuyAndSell() public {
        uint256 held = _buy(bob, token, 10e6);
        _buy(alice, token, 1000e6);
        assertEq(uint8(_state(token).status), uint8(MemeLaunchpad.Status.Completed));

        usd.mint(bob, 1e6);
        vm.startPrank(bob);
        usd.approve(address(lp), 1e6);
        vm.expectRevert(MemeLaunchpad.CurveAlreadyCompleted.selector);
        lp.buy(token, 1e6, 0, block.timestamp, bob);
        vm.expectRevert(MemeLaunchpad.CurveAlreadyCompleted.selector);
        lp.sell(token, held, 0, block.timestamp, bob);
        vm.expectRevert(MemeLaunchpad.CurveAlreadyCompleted.selector);
        lp.quoteBuy(token, 1e6);
        vm.expectRevert(MemeLaunchpad.CurveAlreadyCompleted.selector);
        lp.quoteSell(token, held);
        // The stranded position stays a freely transferable ERC20.
        assertTrue(MemeToken(token).transfer(alice, held));
        vm.stopPrank();
        // Fees remain claimable after completion.
        vm.prank(creator);
        assertGt(lp.claimCreatorFees(token), 0);
    }

    // ------------------------------------------------------------------ fees

    function test_fees_claimsPayCreatorAndTreasury() public {
        _buy(alice, token, 100e6);
        _sell(alice, token, MemeToken(token).balanceOf(alice) / 2);
        uint256 cf = lp.creatorFees(token);
        uint256 pf = lp.protocolFees();
        assertGt(cf, 0);

        vm.expectEmit(address(lp));
        emit MemeLaunchpad.CreatorFeesClaimed(token, creator, cf);
        vm.prank(creator);
        assertEq(lp.claimCreatorFees(token), cf);
        assertEq(usd.balanceOf(creator), cf);
        assertEq(lp.creatorFees(token), 0);

        vm.expectEmit(address(lp));
        emit MemeLaunchpad.ProtocolFeesClaimed(pf);
        vm.prank(mallory); // anyone may trigger it; only the treasury is paid
        assertEq(lp.claimProtocolFees(), pf);
        assertEq(usd.balanceOf(treasury), pf);
        assertEq(usd.balanceOf(mallory), 0);
        assertEq(lp.protocolFees(), 0);

        vm.prank(creator);
        assertEq(lp.claimCreatorFees(token), 0); // nothing left; harmless
        assertEq(
            usd.balanceOf(address(lp)), _state(token).realQuote, "only curve quote stays behind"
        );
    }

    function test_fees_claimCreatorFeesOfUnknownTokenReverts() public {
        vm.prank(creator);
        vm.expectRevert(MemeLaunchpad.NotCreator.selector);
        lp.claimCreatorFees(address(usd));
    }

    // ------------------------------------------------------------------ dust (R-4)

    function test_dust_oneQuoteUnitBuyRevertsZeroOutput() public {
        // fee = ceil(1 * 1%) = 1, net 0: nothing may be charged for nothing.
        vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
        lp.quoteBuy(token, 1);
        usd.mint(alice, 1);
        vm.startPrank(alice);
        usd.approve(address(lp), 1);
        vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
        lp.buy(token, 1, 0, block.timestamp, alice);
        vm.stopPrank();
        // Two units: fee 1, net 1, a positive output.
        (uint256 out,, uint256 fee,) = lp.quoteBuy(token, 2);
        assertEq(fee, 1);
        assertGt(out, 0);
    }

    function test_dust_feesOfOneTwoThreeUnitsSplitExactly() public {
        uint256[3] memory amounts = [uint256(100), 200, 300];
        uint256[3] memory creatorShare = [uint256(0), 1, 1];
        uint256[3] memory protocolShare = [uint256(1), 1, 2];
        for (uint256 i; i < 3; ++i) {
            uint256 cf0 = lp.creatorFees(token);
            uint256 pf0 = lp.protocolFees();
            (,, uint256 fee,) = lp.quoteBuy(token, amounts[i]);
            assertEq(fee, i + 1);
            _buy(alice, token, amounts[i]);
            assertEq(lp.creatorFees(token) - cf0, creatorShare[i]);
            assertEq(lp.protocolFees() - pf0, protocolShare[i]);
        }
    }

    function test_dust_finalBuyOverpaymentStaysWithTheCurve() public {
        _buy(bob, token, 599_999_000); // leave a sliver of the curve
        uint256 netNeeded = CurveRef.ceilDiv(K, VT_END) - _state(token).virtualQuote;
        (uint256 out, uint256 used, uint256 fee, bool completes) = lp.quoteBuy(token, 1000e6);
        assertTrue(completes);
        assertEq(used - fee, netNeeded); // exact: no net dust above netNeeded
        assertEq(fee, CurveRef.fee(used, FEE_BPS)); // the fee rounds up, never down
        _buy(alice, token, 1000e6);
        assertEq(usd.balanceOf(alice), 1000e6 - used);
        assertEq(MemeToken(token).balanceOf(alice), out);
        MemeLaunchpad.CurveState memory s = _state(token);
        // The rounding dust `vQ * vT - K` stays in the curve, and the books still balance.
        assertGe(s.virtualQuote * s.virtualToken, K);
        assertEq(s.virtualQuote, CurveRef.ceilDiv(K, VT_END));
        assertEq(
            usd.balanceOf(address(lp)), s.realQuote + lp.creatorFees(token) + lp.protocolFees()
        );
    }

    function test_dust_zeroOutputQuotesRevert() public {
        _buy(alice, token, 1e6);
        // 1 token base unit is worth far less than one quote unit.
        vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
        lp.quoteSell(token, 1);
        vm.prank(alice);
        vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
        lp.sell(token, 1, 0, block.timestamp, alice);
        // The smallest sell worth one quote unit: gross 1 → fee 1 → out 0 also reverts.
        MemeLaunchpad.CurveState memory s = _state(token);
        uint256 oneUnit = CurveRef.ceilDiv(K, s.virtualQuote - 1) - s.virtualToken;
        (uint256 rOut, uint256 rFee) = _refSell(token, oneUnit);
        assertEq(rOut, 0);
        assertEq(rFee, 1);
        vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
        lp.quoteSell(token, oneUnit);
        vm.expectRevert(MemeLaunchpad.ZeroOutput.selector);
        lp.quoteBuy(token, 1);
    }
}
