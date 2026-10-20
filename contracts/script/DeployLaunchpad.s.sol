// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MemeLaunchpad} from "../src/MemeLaunchpad.sol";

/// @notice Deploys MemeLaunchpad on Mantle Sepolia with plain CREATE: MockUSD as quote, the
///         treasury below and exactly the DESIGN §4.2 curve parameters. The launchpad has no
///         owner, so these constructor arguments are the whole configuration.
///   deploy: forge script script/DeployLaunchpad.s.sol --rpc-url $RPC --broadcast --account ...
///   verify: ADDRESS_BOOK="$(cat ../deployments/mantle-sepolia.json)" \
///           forge script script/DeployLaunchpad.s.sol --sig 'verify()' --rpc-url $RPC
contract DeployLaunchpad is Script {
    using stdJson for string;

    uint256 internal constant CHAIN_ID = 5003;
    /// @dev MockUSD of the AA deployment (contracts/lib/mantle-7702-sdk/deployments).
    address internal constant QUOTE = 0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526;
    address internal constant TREASURY = 0x660e3265781026a148fa6e5Ccbc8fAa76B79B928;

    function params() public pure returns (MemeLaunchpad.CurveParams memory) {
        return MemeLaunchpad.CurveParams({
            totalSupply: 1_000_000_000e18,
            curveSupply: 800_000_000e18,
            virtualToken0: 1_066_666_667e18,
            virtualQuote0: 200e6,
            feeBps: 100
        });
    }

    function constructorArgs() public pure returns (bytes memory) {
        return abi.encode(QUOTE, TREASURY, params());
    }

    function run() external returns (MemeLaunchpad launchpad) {
        require(block.chainid == CHAIN_ID, "chainId mismatch");
        _checkQuote();
        vm.broadcast();
        launchpad = new MemeLaunchpad(QUOTE, TREASURY, params());
        _checkLaunchpad(launchpad);
        console.log("MemeLaunchpad", address(launchpad));
        console.logBytes32(
            keccak256(bytes.concat(type(MemeLaunchpad).creationCode, constructorArgs()))
        );
        console.logBytes32(address(launchpad).codehash);
    }

    /// @notice Read-only on chain: checks `.MemeLaunchpad` of `ADDRESS_BOOK` against the chain
    ///         and the local build (init code, runtime code of a local deployment with the same
    ///         arguments, CREATE address, immutables).
    function verify() external {
        string memory book = vm.envString("ADDRESS_BOOK");
        require(block.chainid == CHAIN_ID, "chainId mismatch");
        require(book.readUint(".chainId") == block.chainid, "book chainId mismatch");
        address launchpad = book.readAddress(".MemeLaunchpad.address");
        require(launchpad.code.length != 0, "launchpad has no code");

        bytes memory args = constructorArgs();
        require(book.readAddress(".MemeLaunchpad.quoteToken") == QUOTE, "book quoteToken");
        require(book.readAddress(".MemeLaunchpad.treasury") == TREASURY, "book treasury");
        require(
            keccak256(book.readBytes(".MemeLaunchpad.constructorArgs.encoded")) == keccak256(args),
            "constructorArgs"
        );
        require(
            book.readBytes32(".MemeLaunchpad.initCodeHash")
                == keccak256(bytes.concat(type(MemeLaunchpad).creationCode, args)),
            "initCodeHash != local build"
        );
        require(
            vm.computeCreateAddress(
                book.readAddress(".MemeLaunchpad.deployer"), book.readUint(".MemeLaunchpad.nonce")
            ) == launchpad,
            "address is not CREATE(deployer, nonce)"
        );
        require(
            launchpad.codehash == book.readBytes32(".MemeLaunchpad.runtimeCodeHash"),
            "codehash != book"
        );
        // Immutables contain no address(this), so a local deployment has identical runtime code.
        require(
            address(new MemeLaunchpad(QUOTE, TREASURY, params())).codehash == launchpad.codehash,
            "codehash != local build"
        );

        _checkQuote();
        _checkLaunchpad(MemeLaunchpad(launchpad));
        console.log("MemeLaunchpad verified", launchpad);
    }

    function _checkQuote() internal view {
        require(QUOTE.code.length != 0, "quote has no code");
        require(IERC20Metadata(QUOTE).decimals() == 6, "quote decimals != 6");
    }

    function _checkLaunchpad(MemeLaunchpad l) internal view {
        MemeLaunchpad.CurveParams memory p = params();
        require(l.quoteToken() == QUOTE, "quoteToken");
        require(l.treasury() == TREASURY, "treasury");
        require(l.TOTAL_SUPPLY() == p.totalSupply, "TOTAL_SUPPLY");
        require(l.CURVE_SUPPLY() == p.curveSupply, "CURVE_SUPPLY");
        require(l.VIRTUAL_TOKEN_0() == p.virtualToken0, "VIRTUAL_TOKEN_0");
        require(l.VIRTUAL_QUOTE_0() == p.virtualQuote0, "VIRTUAL_QUOTE_0");
        require(l.FEE_BPS() == p.feeBps, "FEE_BPS");
        require(l.K() == p.virtualToken0 * p.virtualQuote0, "K");
    }
}
