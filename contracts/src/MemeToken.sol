// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A meme token deployed by `MemeLaunchpad`. Plain ERC20 balances (no fee, rebase, hook
///         or callback), freely transferable, 18 decimals. The whole supply is minted to the
///         launchpad in the constructor; there is no later mint, no burn and no owner.
contract MemeToken is ERC20 {
    error NotLaunchpad();

    /// @notice The launchpad that deployed this token: the only caller of `launchpadTransfer`.
    address public immutable launchpad;

    constructor(string memory name_, string memory symbol_, uint256 supply) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        _mint(msg.sender, supply);
    }

    /// @notice Moves exactly `amount` from `from` to the launchpad without an allowance, or
    ///         reverts. The launchpad only ever passes its own `msg.sender` as `from`.
    function launchpadTransfer(address from, uint256 amount) external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _transfer(from, launchpad, amount);
    }
}
