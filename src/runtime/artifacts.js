//
// plugin/artifacts.js
//
// Convenience loader for hardhat build artifacts. TronWeb wants the
// `{ abi, bytecode }` shape, not an ethers ContractFactory.
//

const fs = require('fs');

function loadArtifact(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`Artifact not found at ${absPath}. Run 'npm run compile' first.`);
  }
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

module.exports = { loadArtifact };
