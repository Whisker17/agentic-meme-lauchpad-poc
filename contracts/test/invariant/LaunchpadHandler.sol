// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {MockUSD} from "mantle-7702-sdk/src/mocks/MockUSD.sol";
import {MemeLaunchpad} from "../../src/MemeLaunchpad.sol";
import {MemeToken} from "../../src/MemeToken.sol";
import {CurveRef} from "../LaunchpadBase.sol";

/// @notice Drives the launchpad for the invariant suite. Every successful trade is measured from
///         balances around the call and compared with `quoteBuy` / `quoteSell` (taken just
///         before) and with the reference formulas; a mismatch increments a violation counter
///         that an invariant asserts to be zero.
contract LaunchpadHandler is CommonBase, StdUtils {
    uint256 internal constant MAX_TOKENS = 6;

    struct Snap {
        uint256 usd;
        uint256 meme;
        uint256 vQ;
        uint256 vT;
        uint256 creatorFees;
        uint256 protocolFees;
        MemeLaunchpad.Status status;
    }

    MemeLaunchpad public immutable lp;
    MockUSD public immutable usd;
    bool public immutable donations;
    uint256 internal immutable k;
    uint256 internal immutable vTEnd;
    uint256 internal immutable feeBps;

    address[] public tokenList;
    address[3] internal actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint256 internal nonce;

    // Ghost fee ledger: collected (from each trade's quoted fee) and claimed (paid out).
    mapping(address token => uint256) public ghostCreatorCollected;
    mapping(address token => uint256) public ghostCreatorClaimed;
    uint256 public ghostProtocolCollected;
    uint256 public ghostProtocolClaimed;
    // Donations (donation fixture only).
    uint256 public ghostQuoteDonated;
    mapping(address token => uint256) public ghostTokenDonated;

    // Violations, one counter per invariant.
    uint256 public vC2; // a round trip returned more than it paid
    uint256 public vC3; // a fee split or claim did not match
    uint256 public vC5; // a trade succeeded on a completed curve
    uint256 public vC6; // a completing buy diverged from its quote / the reference
    uint256 public vQuote; // any other trade diverged from its quote / the reference

    // Coverage.
    uint256 public buys;
    uint256 public sells;
    uint256 public completions;
    uint256 public roundTrips;

    constructor(MemeLaunchpad lp_, MockUSD usd_, bool donations_) {
        lp = lp_;
        usd = usd_;
        donations = donations_;
        k = lp_.K();
        vTEnd = lp_.VIRTUAL_TOKEN_0() - lp_.CURVE_SUPPLY();
        feeBps = lp_.FEE_BPS();
        createToken(0, "first");
        createToken(1, "second");
    }

    function tokenCount() external view returns (uint256) {
        return tokenList.length;
    }

    // ------------------------------------------------------------------ actions

    function createToken(uint256 actorSeed, bytes32 salt) public {
        if (tokenList.length >= MAX_TOKENS) return;
        vm.prank(_actor(actorSeed));
        try lp.createToken("Meme", "MEME", "", "", salt) returns (address t) {
            tokenList.push(t);
        } catch {}
    }

    /// Half the buys are small, half may run past the end of the curve.
    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 amountIn) external {
        amountIn = amountIn % 2 == 0 ? bound(amountIn, 1, 50e6) : bound(amountIn, 1, 1000e6);
        _buy(_actor(actorSeed), _token(tokenSeed), amountIn);
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        address t = _token(tokenSeed);
        uint256 held = MemeToken(t).balanceOf(a);
        _sell(a, t, held == 0 ? bound(amount, 1, 1e24) : bound(amount, 1, held));
    }

    /// C2: a fresh account buys, then sells everything in up to four pieces at once.
    function roundTrip(uint256 tokenSeed, uint256 amountIn, uint256 pieces) external {
        address a = address(uint160(uint256(keccak256(abi.encode("round-trip", nonce++)))));
        address t = _token(tokenSeed);
        amountIn = bound(amountIn, 2, 1000e6);
        (bool ok, uint256 held, uint256 paid) = _buy(a, t, amountIn);
        if (!ok) return;
        pieces = bound(pieces, 1, 4);
        for (uint256 i; i < pieces; ++i) {
            _sell(a, t, i + 1 == pieces ? MemeToken(t).balanceOf(a) : held / pieces);
        }
        uint256 received = usd.balanceOf(a) - (amountIn - paid);
        if (received > paid) ++vC2;
        ++roundTrips;
    }

    function claimCreatorFees(uint256 tokenSeed) external {
        address t = _token(tokenSeed);
        address c = lp.curveState(t).creator;
        uint256 owed = lp.creatorFees(t);
        uint256 bal0 = usd.balanceOf(c);
        vm.prank(c);
        try lp.claimCreatorFees(t) returns (uint256 amount) {
            ghostCreatorClaimed[t] += amount;
            if (amount != owed || usd.balanceOf(c) - bal0 != amount || lp.creatorFees(t) != 0) {
                ++vC3;
            }
        } catch {
            ++vC3;
        }
    }

    function claimProtocolFees(uint256 actorSeed) external {
        address treasury = lp.treasury();
        uint256 owed = lp.protocolFees();
        uint256 bal0 = usd.balanceOf(treasury);
        vm.prank(_actor(actorSeed));
        uint256 amount = lp.claimProtocolFees();
        ghostProtocolClaimed += amount;
        if (amount != owed || usd.balanceOf(treasury) - bal0 != amount || lp.protocolFees() != 0) {
            ++vC3;
        }
    }

    function donateQuote(uint256 amount) external {
        if (!donations) return;
        amount = bound(amount, 1, 100e6);
        usd.mint(address(lp), amount);
        ghostQuoteDonated += amount;
    }

    function donateToken(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        if (!donations) return;
        address a = _actor(actorSeed);
        address t = _token(tokenSeed);
        uint256 held = MemeToken(t).balanceOf(a);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(a);
        require(MemeToken(t).transfer(address(lp), amount));
        ghostTokenDonated[t] += amount;
    }

    // ------------------------------------------------------------------ measured trades

    function _buy(address a, address t, uint256 amountIn)
        internal
        returns (bool ok, uint256 out, uint256 pulled)
    {
        usd.mint(a, amountIn);
        vm.prank(a);
        usd.approve(address(lp), amountIn);
        Snap memory s0 = _snap(a, t);
        (bool quoted, bytes memory q) =
            address(lp).staticcall(abi.encodeCall(MemeLaunchpad.quoteBuy, (t, amountIn)));
        vm.prank(a);
        try lp.buy(t, amountIn, 0, block.timestamp, a) returns (uint256 o) {
            Snap memory s1 = _snap(a, t);
            (ok, out, pulled) = (true, o, s0.usd - s1.usd);
            ++buys;
            if (s0.status != MemeLaunchpad.Status.Trading) {
                ++vC5;
                return (ok, out, pulled);
            }
            if (!quoted) {
                ++vQuote;
                return (ok, out, pulled);
            }
            (uint256 qOut, uint256 qUsed, uint256 qFee, bool qDone) =
                abi.decode(q, (uint256, uint256, uint256, bool));
            bool exact = o == qOut && s1.meme - s0.meme == qOut && pulled == qUsed
                && qUsed <= amountIn && s1.vQ - s0.vQ == qUsed - qFee && s0.vT - s1.vT == qOut
                && _matchesRefBuy(s0, amountIn, qOut, qUsed, qFee, qDone);
            _book(t, qFee, s0, s1);
            if (qDone) {
                ++completions;
                bool done = qOut == s0.vT - vTEnd && s1.status == MemeLaunchpad.Status.Completed;
                if (!exact || !done) ++vC6;
            } else if (!exact || s1.status != MemeLaunchpad.Status.Trading) {
                ++vQuote;
            }
        } catch {
            if (quoted) ++vQuote; // funded, minOut 0, deadline now: only the quote's reverts
        }
    }

    function _sell(address a, address t, uint256 amount) internal {
        Snap memory s0 = _snap(a, t);
        (bool quoted, bytes memory q) =
            address(lp).staticcall(abi.encodeCall(MemeLaunchpad.quoteSell, (t, amount)));
        vm.prank(a);
        try lp.sell(t, amount, 0, block.timestamp, a) returns (uint256 o) {
            ++sells;
            if (s0.status != MemeLaunchpad.Status.Trading) {
                ++vC5;
                return;
            }
            if (!quoted) {
                ++vQuote;
                return;
            }
            Snap memory s1 = _snap(a, t);
            (uint256 qOut, uint256 qFee) = abi.decode(q, (uint256, uint256));
            (uint256 rOut, uint256 rFee) = CurveRef.sell(s0.vT, s0.vQ, k, feeBps, amount);
            bool exact = o == qOut && qOut == rOut && qFee == rFee && s1.usd - s0.usd == qOut
                && s0.meme - s1.meme == amount && s0.vQ - s1.vQ == qOut + qFee
                && s1.vT - s0.vT == amount;
            _book(t, qFee, s0, s1);
            if (!exact) ++vQuote;
        } catch {
            if (quoted && s0.meme >= amount) ++vQuote;
        }
    }

    function _matchesRefBuy(
        Snap memory s0,
        uint256 amountIn,
        uint256 qOut,
        uint256 qUsed,
        uint256 qFee,
        bool qDone
    ) internal view returns (bool) {
        (uint256 rOut, uint256 rUsed, uint256 rFee, bool rDone) =
            CurveRef.buy(s0.vT, s0.vQ, k, vTEnd, feeBps, amountIn);
        return rOut == qOut && rUsed == qUsed && rFee == qFee && rDone == qDone;
    }

    function _book(address t, uint256 fee, Snap memory s0, Snap memory s1) internal {
        ghostCreatorCollected[t] += fee / 2;
        ghostProtocolCollected += fee - fee / 2;
        if (
            s1.creatorFees - s0.creatorFees != fee / 2
                || s1.protocolFees - s0.protocolFees != fee - fee / 2
        ) ++vC3;
    }

    function _snap(address a, address t) internal view returns (Snap memory s) {
        MemeLaunchpad.CurveState memory c = lp.curveState(t);
        s = Snap({
            usd: usd.balanceOf(a),
            meme: MemeToken(t).balanceOf(a),
            vQ: c.virtualQuote,
            vT: c.virtualToken,
            creatorFees: lp.creatorFees(t),
            protocolFees: lp.protocolFees(),
            status: c.status
        });
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (address) {
        return tokenList[seed % tokenList.length];
    }
}
