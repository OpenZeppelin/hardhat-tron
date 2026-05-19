'use strict';

// HTTP keep-alive must install before any other module loads TronWeb
// or axios — those create their HTTP-agent instances at construction
// time and won't pick up a `globalAgent` change after the fact.
require('./runtime/http-agent');

const { extendEnvironment } = require('hardhat/config');

const treWeb = require('./runtime/tre-web');
const cheatcodes = require('./runtime/cheatcodes');
const deploy = require('./runtime/deploy');
const wait = require('./runtime/wait');
const artifacts = require('./runtime/artifacts');

extendEnvironment((hre) => {
  hre.tre = hre.tre || {};
  Object.assign(hre.tre, {
    makeTronWeb: () => treWeb.makeTronWeb(hre),
    rpcCall: cheatcodes.rpcCall,
    mine: cheatcodes.mine,
    setBlockTime: cheatcodes.setBlockTime,
    snapshot: cheatcodes.snapshot,
    revert: cheatcodes.revert,
    deployContract: deploy.deployContract,
    prebuildDeploy: deploy.prebuildDeploy,
    submitPrebuilt: deploy.submitPrebuilt,
    waitForReceipt: wait.waitForReceipt,
    loadArtifact: artifacts.loadArtifact,
  });
});
