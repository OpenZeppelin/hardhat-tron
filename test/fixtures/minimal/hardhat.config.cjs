'use strict';

// Minimal Hardhat project used by the plugin's tests. The plugin is
// loaded via a relative require so the fixture does not need its
// own `node_modules` — tests run against the workspace root's
// hardhat and the plugin source under development.

require('../../../src');

module.exports = {
  solidity: { version: '0.8.20' },
  networks: {
    tre: {
      url: process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc',
      tron: true,
      accounts: [
        // Well-known test key — Hardhat's account 0. Tests that
        // need a different signer override via TRE_PRIVATE_KEY.
        process.env.TRE_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      ],
    },
  },
  tre: {
    // The fixture deliberately disables auto-spawn so unit-style
    // tests don't try to start Docker. End-to-end tests that need a
    // running TRE flip this on at runtime.
    autoStart: false,
    compiler: {
      // tron-solc is the point of the plugin; keep the default
      // target so the fixture exercises the real subtask wiring.
      target: 'tron',
    },
  },
};
