// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {VmSafe} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MemeLaunchpad} from "../src/MemeLaunchpad.sol";
import {MemeToken} from "../src/MemeToken.sol";
import {LaunchpadBase} from "./LaunchpadBase.sol";

/// @notice One test group per clause of the trusted-launchpad interface contract the policy
///         hook relies on (design §4.7), named `test_clauseN_…`.
contract ComplianceTest is LaunchpadBase {
    /// @dev A victim that holds quote and meme and has approved the launchpad without limit.
    function _fundVictim() internal returns (uint256 meme) {
        meme = _buy(alice, token, 100e6);
        usd.mint(alice, 50e6);
        vm.prank(alice);
        usd.approve(address(lp), type(uint256).max);
    }

    // ---- 1: no upgrade / delegatecall / arbitrary calls / admin pulls

    function test_clause1_noOwnerProxyOrAdminEntry() public {
        bytes[5] memory adminCalls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("transferOwnership(address)", mallory),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", mallory, ""),
            abi.encodeWithSignature("withdraw(address,uint256)", address(usd), 1),
            abi.encodeWithSignature("mint(address,uint256)", mallory, 1)
        ];
        for (uint256 i; i < adminCalls.length; ++i) {
            (bool okLp,) = address(lp).call(adminCalls[i]);
            (bool okToken,) = token.call(adminCalls[i]);
            assertFalse(okLp);
            assertFalse(okToken);
        }
        // Not an EIP-1967 proxy.
        bytes32 implSlot = 0x360894a13ba1a3210667c84802fd8c2c66d2d4e9d4cde60226cfb0d6ef8d4c5f;
        assertEq(vm.load(address(lp), implSlot), bytes32(0));
    }

    function test_clause1_callsOnlyQuoteTokenAndOwnTokensWithoutDelegatecall() public {
        usd.mint(alice, 2000e6);
        vm.prank(alice);
        usd.approve(address(lp), type(uint256).max);

        vm.startStateDiffRecording();
        vm.startPrank(alice);
        address t2 = lp.createToken("B", "B", "", "", "b");
        lp.buy(token, 10e6, 0, block.timestamp, alice);
        lp.sell(token, MemeToken(token).balanceOf(alice) / 2, 0, block.timestamp, bob);
        lp.buy(t2, 1000e6, 0, block.timestamp, alice); // truncating
        vm.stopPrank();
        vm.prank(creator);
        lp.claimCreatorFees(token);
        lp.claimProtocolFees();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();

        uint256 fromLaunchpad;
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccessKind kind = acc[i].kind;
            assertTrue(kind != VmSafe.AccountAccessKind.DelegateCall, "delegatecall");
            assertTrue(kind != VmSafe.AccountAccessKind.CallCode, "callcode");
            assertTrue(kind != VmSafe.AccountAccessKind.SelfDestruct, "selfdestruct");
            if (acc[i].accessor != address(lp) || kind == VmSafe.AccountAccessKind.Resume) {
                continue;
            }
            ++fromLaunchpad;
            address target = acc[i].account;
            assertTrue(
                target == address(usd) || target == token || target == t2, "foreign call target"
            );
        }
        assertGt(fromLaunchpad, 0);
    }

    // ---- 2: pull only from msg.sender, only within its call

    function test_clause2_pullsOnlyFromMsgSender() public {
        uint256 meme = _fundVictim();
        uint256 victimUsd = usd.balanceOf(alice);

        // Mallory has no quote: her buy fails instead of drawing on alice's allowance.
        vm.startPrank(mallory);
        usd.approve(address(lp), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, mallory, 0, 1e6)
        );
        lp.buy(token, 1e6, 0, block.timestamp, mallory);
        vm.stopPrank();

        // A funded buyer pays from her own balance only.
        _buy(bob, token, 1e6);
        assertEq(usd.balanceOf(bob), 0);
        assertEq(usd.balanceOf(alice), victimUsd);
        assertEq(MemeToken(token).balanceOf(alice), meme);
    }

    // ---- 3: closed token set, launchpad-only privileged transfer

    function test_clause3_onlyRegisteredTokensTrade() public {
        // A MemeToken built outside the factory (its "launchpad" is mallory) is not registered.
        vm.prank(mallory);
        MemeToken fake = new MemeToken("Fake", "FAKE", TOTAL);
        usd.mint(mallory, 1e6);
        vm.startPrank(mallory);
        usd.approve(address(lp), 1e6);
        vm.expectRevert(MemeLaunchpad.UnknownToken.selector);
        lp.buy(address(fake), 1e6, 0, block.timestamp, mallory);
        vm.expectRevert(MemeLaunchpad.UnknownToken.selector);
        lp.sell(address(fake), 1e18, 0, block.timestamp, mallory);
        vm.expectRevert(MemeLaunchpad.UnknownToken.selector);
        lp.quoteSell(address(fake), 1e18);
        vm.stopPrank();
        assertFalse(lp.isRegistered(address(fake)));
        assertTrue(lp.isRegistered(token));
        assertEq(MemeToken(token).launchpad(), address(lp));
    }

    function test_clause3_privilegedTransferIsLaunchpadOnly() public {
        uint256 meme = _fundVictim();
        address[3] memory callers = [mallory, alice, address(this)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(MemeToken.NotLaunchpad.selector);
            MemeToken(token).launchpadTransfer(alice, meme);
        }
        assertEq(MemeToken(token).balanceOf(alice), meme);
    }

    // ---- 4: proceeds go to `recipient`

    function test_clause4_proceedsGoToRecipientOnly() public {
        usd.mint(alice, 10e6);
        vm.startPrank(alice);
        usd.approve(address(lp), 10e6);
        uint256 out = lp.buy(token, 10e6, 0, block.timestamp, bob);
        vm.stopPrank();
        assertEq(MemeToken(token).balanceOf(bob), out);
        assertEq(MemeToken(token).balanceOf(alice), 0);

        vm.prank(bob);
        uint256 quoteOut = lp.sell(token, out, 0, block.timestamp, creator);
        assertEq(usd.balanceOf(creator), quoteOut);
        assertEq(usd.balanceOf(bob), 0);
        assertEq(usd.balanceOf(alice), 0);
    }

    // ---- 5: plain balances, immutable quoteToken()

    function test_clause5_plainBalancesAndImmutableQuoteToken() public {
        uint256 meme = _buy(alice, token, 10e6);
        vm.prank(alice);
        assertTrue(MemeToken(token).transfer(bob, meme / 3));
        assertEq(MemeToken(token).balanceOf(bob), meme / 3); // no transfer fee
        assertEq(MemeToken(token).balanceOf(alice), meme - meme / 3);
        assertEq(MemeToken(token).totalSupply(), TOTAL); // no rebase, mint or burn
        assertEq(MemeToken(token).decimals(), 18);
        assertEq(usd.decimals(), 6);
        _sell(bob, token, meme / 3);
        assertEq(lp.quoteToken(), address(usd)); // immutable: no setter exists
        (bool ok,) = address(lp).call(abi.encodeWithSignature("setQuoteToken(address)", mallory));
        assertFalse(ok);
    }

    // ---- 6: exact BUY delta, SELL in full

    function test_clause6_buyDeliversExactlyThisPurchase() public {
        uint256 before = MemeToken(token).balanceOf(alice);
        uint256 out = _buy(alice, token, 25e6);
        assertEq(MemeToken(token).balanceOf(alice) - before, out);
        assertEq(usd.balanceOf(alice), 0); // no quote inflow mixed in

        // The truncating buy delivers exactly the remainder of the curve.
        uint256 remaining = _remaining(token);
        before = MemeToken(token).balanceOf(alice);
        assertEq(_buy(alice, token, 1000e6), remaining);
        assertEq(MemeToken(token).balanceOf(alice) - before, remaining);
    }

    function test_clause6_sellFillsInFullOrReverts() public {
        uint256 meme = _buy(alice, token, 10e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, meme, meme + 1
            )
        );
        lp.sell(token, meme + 1, 0, block.timestamp, alice);
        assertEq(MemeToken(token).balanceOf(alice), meme); // nothing partial

        uint256 lpBefore = MemeToken(token).balanceOf(address(lp));
        _sell(alice, token, meme / 2);
        assertEq(MemeToken(token).balanceOf(alice), meme - meme / 2);
        assertEq(MemeToken(token).balanceOf(address(lp)) - lpBefore, meme / 2);
    }

    // ---- 7: anti-theft (design §10)

    function test_clause7_thirdPartySellCannotReduceVictim() public {
        uint256 meme = _fundVictim();
        vm.startPrank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, mallory, 0, meme)
        );
        lp.sell(token, meme, 0, block.timestamp, mallory);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, mallory, 0, meme)
        );
        lp.sell(token, meme, 0, block.timestamp, alice);
        vm.stopPrank();
        assertEq(MemeToken(token).balanceOf(alice), meme);
    }

    function test_clause7_directPrivilegedTransferRefused() public {
        uint256 meme = _fundVictim();
        vm.prank(mallory);
        vm.expectRevert(MemeToken.NotLaunchpad.selector);
        MemeToken(token).launchpadTransfer(alice, meme);
        assertEq(MemeToken(token).balanceOf(alice), meme);
    }

    function test_clause7_claimCreatorFeesByNonCreatorReverts() public {
        _fundVictim();
        uint256 fees = lp.creatorFees(token);
        address[2] memory others = [mallory, alice];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(MemeLaunchpad.NotCreator.selector);
            lp.claimCreatorFees(token);
        }
        assertEq(lp.creatorFees(token), fees);
    }

    /// Every public entry, called by a third party with the victim as every address argument,
    /// leaves the victim's quote and meme balances untouched.
    function testFuzz_clause7_noEntryPullsVictimAssets(uint256 amount, bytes32 salt) public {
        uint256 meme = _fundVictim();
        uint256 victimUsd = usd.balanceOf(alice);
        amount = bound(amount, 1, 1000e6);
        usd.mint(mallory, amount);
        vm.startPrank(mallory);
        usd.approve(address(lp), amount);
        address[2] memory recipients = [alice, mallory];
        for (uint256 i; i < 2; ++i) {
            try lp.buy(token, amount, 0, block.timestamp, recipients[i]) {} catch {}
            try lp.sell(token, amount, 0, block.timestamp, recipients[i]) {} catch {}
            try lp.sell(token, meme, 0, block.timestamp, recipients[i]) {} catch {}
        }
        try lp.claimCreatorFees(token) {} catch {}
        lp.claimProtocolFees();
        lp.createToken("X", "X", "", "", salt);
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), victimUsd);
        assertGe(MemeToken(token).balanceOf(alice), meme); // may only grow (mallory's gift)
        assertEq(usd.allowance(alice, address(lp)), type(uint256).max);
    }

    function test_clause7_create2CannotBeSquatted() public {
        bytes32 salt = "alice-launch";
        address predicted = lp.predictTokenAddress(alice, salt, "Pepe", "PEPE");
        // Mallory front-runs with alice's salt, name and symbol: a different address.
        address squat = _create(mallory, salt);
        assertTrue(squat != predicted);
        assertEq(lp.curveState(squat).creator, mallory);
        // Alice still deploys at her predicted address, as its creator.
        assertEq(_create(alice, salt), predicted);
        assertEq(lp.curveState(predicted).creator, alice);
    }
}
