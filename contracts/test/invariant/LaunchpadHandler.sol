// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MockUSD} from "mantle-7702-sdk/src/mocks/MockUSD.sol";
import {MemeLaunchpad} from "../../src/MemeLaunchpad.sol";
import {MemeToken} from "../../src/MemeToken.sol";
import {CurveRef} from "../LaunchpadBase.sol";

/// @notice Drives the launchpad for the invariant suite. Every successful trade is measured from
///         balances around the call and compared with `quoteBuy` / `quoteSell` (taken just
///         before) and with the reference formulas; a mismatch increments a violation counter
///         that an invariant asserts to be zero. Whether a trade (and its quote) should succeed
///         or revert, and with which error, is predicted independently from the curve state,
///         the reference formulas and the caller's balance; any other outcome is a violation.
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
    uint256 public vRevert; // a protocol call reverted (or not) other than predicted

    // Coverage: successful calls only (a round trip counts once it bought and sold everything).
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
        address a = _actor(actorSeed);
        // The only expected failure: the same creator reusing a salt (CREATE2 collision).
        bool taken = lp.predictTokenAddress(a, salt, "Meme", "MEME").code.length > 0;
        vm.prank(a);
        try lp.createToken("Meme", "MEME", "", "", salt) returns (address t) {
            tokenList.push(t);
            if (taken) ++vRevert;
        } catch {
            if (!taken) ++vRevert;
        }
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
    function roundTrip(uint256 tokenSeed, uint256 amountIn, uint256 pieces) public {
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
        if (MemeToken(t).balanceOf(a) == 0) ++roundTrips;
    }

    /// Not a fuzz target: run after every campaign run, so that each run proves trading works in
    /// its final state. On a fresh curve: an executed round trip, then a completing buy.
    function probe() external {
        vm.prank(address(uint160(uint256(keccak256(abi.encode("probe", nonce++))))));
        tokenList.push(lp.createToken("Meme", "MEME", "", "", 0));
        roundTrip(tokenList.length - 1, 10e6, 2);
        _buy(_actor(0), tokenList[tokenList.length - 1], 1000e6);
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
        try lp.claimProtocolFees() returns (uint256 amount) {
            ghostProtocolClaimed += amount;
            if (
                amount != owed || usd.balanceOf(treasury) - bal0 != amount || lp.protocolFees() != 0
            ) {
                ++vC3;
            }
        } catch {
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
        if (!_as(quoted, q, _expectBuy(s0, amountIn))) ++vQuote;
        vm.prank(a);
        try lp.buy(t, amountIn, 0, block.timestamp, a) returns (uint256 o) {
            Snap memory s1 = _snap(a, t);
            (ok, out, pulled) = (true, o, s0.usd - s1.usd);
            ++buys;
            if (_expectBuy(s0, amountIn) != OK) ++vRevert;
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
        } catch (bytes memory err) {
            if (!_as(false, err, _expectBuy(s0, amountIn))) ++vRevert; // funded, minOut 0, deadline now
        }
    }

    function _sell(address a, address t, uint256 amount) internal {
        Snap memory s0 = _snap(a, t);
        (bool quoted, bytes memory q) =
            address(lp).staticcall(abi.encodeCall(MemeLaunchpad.quoteSell, (t, amount)));
        if (!_as(quoted, q, _expectQuoteSell(s0, amount))) ++vQuote;
        vm.prank(a);
        try lp.sell(t, amount, 0, block.timestamp, a) returns (uint256 o) {
            ++sells;
            if (_expectSell(s0, amount) != OK) ++vRevert;
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
        } catch (bytes memory err) {
            if (!_as(false, err, _expectSell(s0, amount))) ++vRevert;
        }
    }

    // ------------------------------------------------------------------ expected outcomes

    bytes4 internal constant OK = bytes4(0);

    /// The error a funded `buy` (minOut 0, deadline now) must revert with, or OK.
    function _expectBuy(Snap memory s0, uint256 amountIn) internal view returns (bytes4) {
        if (s0.status != MemeLaunchpad.Status.Trading) {
            return MemeLaunchpad.CurveAlreadyCompleted.selector;
        }
        (uint256 out, uint256 used, uint256 fee,) =
            CurveRef.buy(s0.vT, s0.vQ, k, vTEnd, feeBps, amountIn);
        return out == 0 || used == fee ? MemeLaunchpad.ZeroOutput.selector : OK;
    }

    /// The error a `sell` (minOut 0, deadline now) must revert with, or OK.
    function _expectSell(Snap memory s0, uint256 amount) internal view returns (bytes4 want) {
        want = _expectQuoteSell(s0, amount);
        if (want == OK && s0.meme < amount) want = IERC20Errors.ERC20InsufficientBalance.selector;
    }

    /// The same for `quoteSell`, which does not look at the seller's balance.
    function _expectQuoteSell(Snap memory s0, uint256 amount) internal view returns (bytes4) {
        if (s0.status != MemeLaunchpad.Status.Trading) {
            return MemeLaunchpad.CurveAlreadyCompleted.selector;
        }
        if (amount == 0) return MemeLaunchpad.ZeroAmount.selector;
        (uint256 out,) = CurveRef.sell(s0.vT, s0.vQ, k, feeBps, amount);
        return out == 0 ? MemeLaunchpad.ZeroOutput.selector : OK;
    }

    /// Whether a call's outcome is `want`: success for OK, else a revert with that error.
    function _as(bool ok, bytes memory ret, bytes4 want) internal pure returns (bool) {
        if (want == OK) return ok;
        return !ok && ret.length >= 4 && bytes4(ret) == want;
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
