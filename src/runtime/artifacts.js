'use strict';

// Convenience loader for Hardhat build artifacts. TronWeb wants the
// `{ abi, bytecode }` shape, not an ethers ContractFactory.

const fs = require('node:fs');

function loadArtifact(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Artifact not found at ${absPath}. Run 'npm run compile' first.`);
  }
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

module.exports = { loadArtifact };
