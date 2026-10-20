// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaunchpad} from "mantle-7702-sdk/src/interfaces/ILaunchpad.sol";
import {MemeToken} from "./MemeToken.sol";

/// @notice Bonding-curve launchpad and MemeToken factory. Constant product over virtual reserves,
///         one immutable parameter set, no owner, no upgrade path, no delegatecall; the only
///         external calls go to the quote token and to MemeTokens this contract deployed.
/// @dev    Every amount is in base units. `k / x` always rounds up, so rounding favours the curve
///         and `vQ * vT >= K` holds in every state.
contract MemeLaunchpad is ILaunchpad {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Trading,
        Completed,
        Graduated // reserved for a future version that migrates; unreachable here
    }

    struct CurveParams {
        uint256 totalSupply; // minted to the launchpad per token
        uint256 curveSupply; // sellable on the curve; the rest is reserved
        uint256 virtualToken0;
        uint256 virtualQuote0;
        uint256 feeBps; // on buys and sells, split creator floor half / protocol remainder
    }

    struct CurveState {
        uint256 virtualToken; // vT
        uint256 virtualQuote; // vQ
        uint256 sold; // curve tokens no longer held by the curve
        uint256 realQuote; // vQ - virtualQuote0
        uint256 priceE18; // vQ * 1e18 / vT: quote base units per whole token
        address creator;
        uint64 createdAt;
        Status status;
    }

    struct Curve {
        uint256 vT;
        uint256 vQ;
        address creator;
        uint64 createdAt;
        Status status;
    }

    uint256 internal constant BPS = 10_000;

    /// @notice The quote asset (immutable, as the policy hook requires).
    address public immutable quoteToken;
    /// @notice The only recipient of protocol fees.
    address public immutable treasury;
    uint256 public immutable TOTAL_SUPPLY;
    uint256 public immutable CURVE_SUPPLY;
    uint256 public immutable VIRTUAL_TOKEN_0;
    uint256 public immutable VIRTUAL_QUOTE_0;
    uint256 public immutable FEE_BPS;
    /// @notice The curve constant `VIRTUAL_TOKEN_0 * VIRTUAL_QUOTE_0`.
    uint256 public immutable K;

    /// @notice Protocol fees collected and not yet claimed.
    uint256 public protocolFees;
    /// @notice Creator fees collected per token and not yet claimed.
    mapping(address token => uint256) public creatorFees;

    mapping(address token => Curve) internal _curves;
    address[] internal _tokens;

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        string description,
        string imageUrl,
        bytes32 salt
    );
    /// @dev `quoteAmount` is the quote pulled (buy, fee included) or paid out (sell, fee
    ///      excluded); `vQ` / `vT` are the reserves after the trade.
    event Trade(
        address indexed token,
        address indexed trader,
        address recipient,
        bool isBuy,
        uint256 quoteAmount,
        uint256 tokenAmount,
        uint256 fee,
        uint256 vQ,
        uint256 vT
    );
    event CurveCompleted(address indexed token, uint256 realQuote);
    event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
    event ProtocolFeesClaimed(uint256 amount);

    error InvalidParams();
    error UnknownToken();
    /// @dev The curve is sold out; buy and sell are disabled (the `CURVE_COMPLETED` condition).
    error CurveAlreadyCompleted();
    error Expired();
    error ZeroAmount();
    error ZeroOutput();
    error InsufficientOutput();
    error NotCreator();

    constructor(address quoteToken_, address treasury_, CurveParams memory p) {
        if (
            quoteToken_ == address(0) || treasury_ == address(0) || p.curveSupply == 0
                || p.curveSupply > p.totalSupply || p.curveSupply >= p.virtualToken0
                || p.virtualQuote0 == 0 || p.feeBps >= BPS
        ) revert InvalidParams();
        quoteToken = quoteToken_;
        treasury = treasury_;
        TOTAL_SUPPLY = p.totalSupply;
        CURVE_SUPPLY = p.curveSupply;
        VIRTUAL_TOKEN_0 = p.virtualToken0;
        VIRTUAL_QUOTE_0 = p.virtualQuote0;
        FEE_BPS = p.feeBps;
        K = p.virtualToken0 * p.virtualQuote0;
    }

    // ------------------------------------------------------------------ create

    /// @notice Deploys a MemeToken with CREATE2 under `keccak256(abi.encode(msg.sender, salt))`
    ///         and opens its curve. Takes no payment and sends nothing to the caller.
    function createToken(
        string calldata name,
        string calldata symbol,
        string calldata description,
        string calldata imageUrl,
        bytes32 salt
    ) external returns (address token) {
        token = address(new MemeToken{salt: _salt(msg.sender, salt)}(name, symbol, TOTAL_SUPPLY));
        _curves[token] = Curve({
            vT: VIRTUAL_TOKEN_0,
            vQ: VIRTUAL_QUOTE_0,
            creator: msg.sender,
            createdAt: uint64(block.timestamp),
            status: Status.Trading
        });
        _tokens.push(token);
        emit TokenCreated(token, msg.sender, name, symbol, description, imageUrl, salt);
    }

    /// @notice The address `createToken(name, symbol, …, salt)` called by `creator` deploys to.
    function predictTokenAddress(
        address creator,
        bytes32 salt,
        string calldata name,
        string calldata symbol
    ) external view returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(MemeToken).creationCode, abi.encode(name, symbol, TOTAL_SUPPLY)
        );
        return Create2.computeAddress(_salt(creator, salt), keccak256(initCode));
    }

    // ------------------------------------------------------------------ trade

    /// @notice Buys `token` with at most `amountIn` quote pulled from `msg.sender`. A buy that
    ///         reaches the end of the curve is truncated: it pulls only `amountInUsed` and
    ///         completes the curve.
    function buy(
        address token,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut) {
        uint256 amountInUsed;
        uint256 feeUsed;
        bool completes;
        (amountOut, amountInUsed, feeUsed, completes) = quoteBuy(token, amountIn);
        _checkTrade(deadline, amountOut, minOut);

        Curve storage c = _curves[token];
        c.vQ += amountInUsed - feeUsed;
        c.vT -= amountOut;
        if (completes) c.status = Status.Completed;
        _bookFee(token, feeUsed);

        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), amountInUsed);
        IERC20(token).safeTransfer(recipient, amountOut);
        emit Trade(token, msg.sender, recipient, true, amountInUsed, amountOut, feeUsed, c.vQ, c.vT);
        if (completes) emit CurveCompleted(token, c.vQ - VIRTUAL_QUOTE_0);
    }

    /// @notice Sells exactly `amount` of `token` taken from `msg.sender` (no approve) and pays the
    ///         proceeds net of the fee to `recipient`.
    function sell(
        address token,
        uint256 amount,
        uint256 minOut,
        uint256 deadline,
        address recipient
    ) external returns (uint256 amountOut) {
        uint256 fee;
        (amountOut, fee) = quoteSell(token, amount);
        _checkTrade(deadline, amountOut, minOut);

        Curve storage c = _curves[token];
        c.vQ -= amountOut + fee;
        c.vT += amount;
        _bookFee(token, fee);

        MemeToken(token).launchpadTransfer(msg.sender, amount);
        IERC20(quoteToken).safeTransfer(recipient, amountOut);
        emit Trade(token, msg.sender, recipient, false, amountOut, amount, fee, c.vQ, c.vT);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Pays the creator fees of `token` to its creator, who must be the caller.
    function claimCreatorFees(address token) external returns (uint256 amount) {
        if (msg.sender != _curves[token].creator) revert NotCreator();
        amount = creatorFees[token];
        creatorFees[token] = 0;
        IERC20(quoteToken).safeTransfer(msg.sender, amount);
        emit CreatorFeesClaimed(token, msg.sender, amount);
    }

    /// @notice Pays all protocol fees to the immutable treasury. Anyone may call it.
    function claimProtocolFees() external returns (uint256 amount) {
        amount = protocolFees;
        protocolFees = 0;
        IERC20(quoteToken).safeTransfer(treasury, amount);
        emit ProtocolFeesClaimed(amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice Exactly what `buy(token, amountIn, …)` does in the current state: tokens out,
    ///         quote pulled, fee booked, and whether the buy completes the curve. Reverts as `buy`
    ///         would (except for deadline and slippage).
    function quoteBuy(address token, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 amountInUsed, uint256 feeUsed, bool completes)
    {
        Curve storage c = _trading(token);
        if (amountIn == 0) revert ZeroAmount();
        uint256 vT = c.vT;
        uint256 vQ = c.vQ;
        uint256 vTEnd = VIRTUAL_TOKEN_0 - CURVE_SUPPLY;
        uint256 remaining = vT - vTEnd;

        amountInUsed = amountIn;
        feeUsed = _fee(amountIn);
        amountOut = vT - Math.ceilDiv(K, vQ + amountIn - feeUsed);
        if (amountOut >= remaining) {
            // Final-buy truncation. `amountOut >= remaining` holds exactly when the requested
            // net `amountIn - feeUsed >= netNeeded`. With g(x) = x - ceil(x * FEE_BPS / BPS):
            // x0 = ceil(netNeeded * BPS / (BPS - FEE_BPS)) gives g(x0) > x0 * (BPS - FEE_BPS) /
            // BPS - 1 >= netNeeded - 1, so g(x0) >= netNeeded; and every x < x0 has g(x) <=
            // x * (BPS - FEE_BPS) / BPS < netNeeded. So x0 is the smallest x with
            // g(x) >= netNeeded (the "+1 while it fails" step never runs), and since amountIn
            // satisfies it, amountInUsed = x0 <= amountIn. g steps by 0 or 1, so the net booked
            // is exactly netNeeded and vQ ends at ceil(K / vTEnd).
            uint256 netNeeded = Math.ceilDiv(K, vTEnd) - vQ;
            amountInUsed = Math.ceilDiv(netNeeded * BPS, BPS - FEE_BPS);
            feeUsed = _fee(amountInUsed);
            amountOut = remaining;
            completes = true;
        }
        if (amountInUsed == feeUsed || amountOut == 0) revert ZeroOutput();
    }

    /// @notice Exactly what `sell(token, amount, …)` pays out and the fee it books.
    function quoteSell(address token, uint256 amount)
        public
        view
        returns (uint256 amountOut, uint256 fee)
    {
        Curve storage c = _trading(token);
        if (amount == 0) revert ZeroAmount();
        uint256 gross = c.vQ - Math.ceilDiv(K, c.vT + amount);
        fee = _fee(gross);
        amountOut = gross - fee;
        if (amountOut == 0) revert ZeroOutput();
    }

    /// @notice Reserves, progress and price of `token`; all zero (status `None`) if unknown.
    function curveState(address token) external view returns (CurveState memory s) {
        Curve storage c = _curves[token];
        if (c.status == Status.None) return s;
        s = CurveState({
            virtualToken: c.vT,
            virtualQuote: c.vQ,
            sold: VIRTUAL_TOKEN_0 - c.vT,
            realQuote: c.vQ - VIRTUAL_QUOTE_0,
            priceE18: c.vQ * 1e18 / c.vT,
            creator: c.creator,
            createdAt: c.createdAt,
            status: c.status
        });
    }

    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    /// @notice Up to `limit` registered tokens in creation order, starting at `offset`.
    function tokens(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _tokens.length;
        if (offset > n) offset = n;
        if (limit > n - offset) limit = n - offset;
        page = new address[](limit);
        for (uint256 i; i < limit; ++i) {
            page[i] = _tokens[offset + i];
        }
    }

    function isRegistered(address token) external view returns (bool) {
        return _curves[token].status != Status.None;
    }

    // ------------------------------------------------------------------ internal

    function _trading(address token) internal view returns (Curve storage c) {
        c = _curves[token];
        if (c.status == Status.None) revert UnknownToken();
        if (c.status != Status.Trading) revert CurveAlreadyCompleted();
    }

    function _checkTrade(uint256 deadline, uint256 amountOut, uint256 minOut) internal view {
        // forge-lint: disable-next-line(block-timestamp) -- the deadline is part of the ABI
        if (block.timestamp > deadline) revert Expired();
        if (amountOut < minOut) revert InsufficientOutput();
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return Math.ceilDiv(amount * FEE_BPS, BPS);
    }

    function _bookFee(address token, uint256 fee) internal {
        creatorFees[token] += fee / 2;
        protocolFees += fee - fee / 2;
    }

    function _salt(address creator, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }
}
