'use strict';

// Minimal Hardhat project used by the plugin's tests. The plugin is
// loaded via a relative require so the fixture does not need its
// own `node_modules` — tests run against the workspace root's
// hardhat and the plugin source under development.
//
// hardhat-ethers must be required BEFORE the plugin: it registers the
// `extendEnvironment` hook that provides `hre.ethers`, which the plugin's
// bridge then decorates for TronWeb. Order matters — the plugin assumes
// `hre.ethers` already exists when its own hook runs.

require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('../../../src');

module.exports = {
  solidity: { version: '0.8.20' },
  networks: {
    tre: {
      url: process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc',
      tron: true,
      accounts: [
        // Well-known TRE dev key — funded account #0 in the tronbox/tre
        // image's genesis. (The image funds its own default accounts, not
        // ones derived from the displayed mnemonic.) Tests that need a
        // different signer override via TRE_PRIVATE_KEY.
        process.env.TRE_PRIVATE_KEY || '0xdd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5',
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
