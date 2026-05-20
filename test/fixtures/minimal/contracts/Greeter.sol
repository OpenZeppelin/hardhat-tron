// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Minimal contract used by the plugin's compile and e2e test fixtures.
contract Greeter {
    string public greeting;

    event GreetingChanged(string greeting);

    constructor(string memory _greeting) {
        greeting = _greeting;
    }

    function setGreeting(string memory _greeting) external {
        greeting = _greeting;
        emit GreetingChanged(_greeting);
    }
}
