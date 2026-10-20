// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MemeLaunchpad} from "../../src/MemeLaunchpad.sol";
import {MemeToken} from "../../src/MemeToken.sol";
import {CurveRef, LaunchpadBase} from "../LaunchpadBase.sol";
import {LaunchpadHandler} from "./LaunchpadHandler.sol";

/// @notice Invariants C1–C6 of the design (§10) in a fixture without donations, where the
///         solvency and supply equalities are exact. The handler catches every protocol revert it
///         predicts, so any revert reaching the fuzzer is a failure.
/// forge-config: default.invariant.fail-on-revert = true
contract MemeLaunchpadInvariantTest is LaunchpadBase {
    LaunchpadHandler internal handler;

    function donations() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        handler = new LaunchpadHandler(lp, usd, donations());
        bytes4[] memory selectors = new bytes4[](donations() ? 9 : 7);
        selectors[0] = LaunchpadHandler.createToken.selector;
        selectors[1] = LaunchpadHandler.buy.selector;
        selectors[2] = LaunchpadHandler.buy.selector; // trades twice as often as the rest
        selectors[3] = LaunchpadHandler.sell.selector;
        selectors[4] = LaunchpadHandler.roundTrip.selector;
        selectors[5] = LaunchpadHandler.claimCreatorFees.selector;
        selectors[6] = LaunchpadHandler.claimProtocolFees.selector;
        if (donations()) {
            selectors[7] = LaunchpadHandler.donateQuote.selector;
            selectors[8] = LaunchpadHandler.donateToken.selector;
        }
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Runs once at the end of every run. A suite that passes with trading broken proves nothing:
    /// a fresh curve must still take a full round trip and a completing buy, with no violation
    /// and no unpredicted revert (the latter also covers every call of the run itself).
    function afterInvariant() public {
        (uint256 b, uint256 s, uint256 r, uint256 c) =
            (handler.buys(), handler.sells(), handler.roundTrips(), handler.completions());
        handler.probe();
        assertEq(handler.buys(), b + 2, "probe: buys");
        assertEq(handler.sells(), s + 2, "probe: sells");
        assertEq(handler.roundTrips(), r + 1, "probe: round trip");
        assertEq(handler.completions(), c + 1, "probe: completion");
        assertEq(handler.vRevert(), 0, "unpredicted revert or success");
        assertEq(handler.vQuote(), 0, "trade diverged from its quote");
        assertEq(handler.vC2() + handler.vC3() + handler.vC5() + handler.vC6(), 0, "violation");
    }

    function _all() internal view returns (address[] memory) {
        return lp.tokens(0, type(uint256).max);
    }

    /// C1 solvency: the launchpad holds every curve reserve and every unclaimed fee (exactly,
    /// absent donations); `vQ * vT >= K`; selling every outstanding curve token returns at most
    /// `realQuote`; and the remainder of a trading curve is never free.
    function invariant_C1_solvency() public view {
        address[] memory all = _all();
        uint256 liabilities = lp.protocolFees();
        for (uint256 i; i < all.length; ++i) {
            MemeLaunchpad.CurveState memory s = lp.curveState(all[i]);
            liabilities += s.realQuote + lp.creatorFees(all[i]);
            assertGe(s.virtualQuote * s.virtualToken, K, "vQ * vT < K");
            uint256 sellAll = s.virtualQuote - CurveRef.ceilDiv(K, s.virtualToken + s.sold);
            assertLe(sellAll, s.realQuote, "selling everything pays more than realQuote");
            if (s.status == MemeLaunchpad.Status.Trading) {
                assertGe(CurveRef.ceilDiv(K, VT_END), s.virtualQuote + 1, "free remainder");
            }
        }
        uint256 held = usd.balanceOf(address(lp));
        assertGe(held, liabilities, "insolvent");
        assertEq(held, liabilities + handler.ghostQuoteDonated(), "quote not accounted for");
    }

    /// C2: buying and then selling (any split) never returns more than was paid.
    function invariant_C2_noFreeRoundTrip() public view {
        assertEq(handler.vC2(), 0);
    }

    /// C3: fees collected = claimed + claimable, split creator floor / protocol remainder.
    function invariant_C3_feeConservation() public view {
        assertEq(handler.vC3(), 0, "split or claim mismatch");
        address[] memory all = _all();
        for (uint256 i; i < all.length; ++i) {
            assertEq(
                handler.ghostCreatorCollected(all[i]),
                handler.ghostCreatorClaimed(all[i]) + lp.creatorFees(all[i]),
                "creator fees"
            );
        }
        assertEq(
            handler.ghostProtocolCollected(),
            handler.ghostProtocolClaimed() + lp.protocolFees(),
            "protocol fees"
        );
        assertEq(usd.balanceOf(lp.treasury()), handler.ghostProtocolClaimed(), "treasury");
    }

    /// C4: total supply is constant; the launchpad holds unsold curve + reserved supply.
    function invariant_C4_supply() public view {
        address[] memory all = _all();
        for (uint256 i; i < all.length; ++i) {
            MemeToken t = MemeToken(all[i]);
            assertEq(t.totalSupply(), TOTAL, "supply changed");
            uint256 expected = CURVE - lp.curveState(all[i]).sold + RESERVED;
            uint256 held = t.balanceOf(address(lp));
            assertGe(held, expected, "launchpad short of tokens");
            assertEq(held, expected + handler.ghostTokenDonated(all[i]), "tokens not accounted");
        }
    }

    /// C5: no trade after `Completed`; `Graduated` is unreachable; completed = sold out.
    function invariant_C5_lifecycle() public view {
        assertEq(handler.vC5(), 0, "trade on a completed curve");
        address[] memory all = _all();
        for (uint256 i; i < all.length; ++i) {
            MemeLaunchpad.CurveState memory s = lp.curveState(all[i]);
            assertTrue(s.status != MemeLaunchpad.Status.Graduated, "graduated");
            assertTrue(s.status != MemeLaunchpad.Status.None, "registered but None");
            assertEq(s.status == MemeLaunchpad.Status.Completed, s.sold == CURVE, "completion");
        }
    }

    /// C6: every completing buy pulled `amountInUsed <= amountIn`, delivered exactly the
    /// remainder, booked only `netUsed` / `feeUsed`, and matched `quoteBuy` and the reference;
    /// every other trade matched its quote as well.
    function invariant_C6_truncation() public view {
        assertEq(handler.vC6(), 0, "completing buy diverged");
        assertEq(handler.vQuote(), 0, "trade diverged from its quote");
        assertEq(handler.vRevert(), 0, "unpredicted revert or success");
    }
}

/// @notice The same invariants with quote and token donations to the launchpad: solvency and
///         supply then hold as strict inequalities (and exactly, net of the donations).
/// forge-config: default.invariant.fail-on-revert = true
contract MemeLaunchpadDonationInvariantTest is MemeLaunchpadInvariantTest {
    function donations() internal pure override returns (bool) {
        return true;
    }
}
