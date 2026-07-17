'use strict';

// HTTP keep-alive must install before any other module loads TronWeb
// or axios — those create their HTTP-agent instances at construction
// time and won't pick up a `globalAgent` change after the fact.
require('./runtime/http-agent');

// Compile pipeline (extendConfig + subtask hooks). Loaded for its
// side-effects — registers `tre.compiler.*` config and the
// tron-solc compile subtasks.
require('./compile');

// `tron:compile-batches` task. Loaded for its side-effect of
// registering the task; only runs when the user invokes it.
require('./tasks/tron-compile-batches');

// TRE lifecycle config (`tre.image`, `tre.port`, `tre.jarPath`, …).
// Loaded for the side-effect of `extendConfig`. The lifecycle
// module itself (`src/tre/lifecycle.js`) is a standalone surface
// for consumers that want to spawn / tear down a container
// manually.
require('./tre/config');

// Auto-spawn a TRE container on `hardhat test` (gated on
// `tre.autoStart` + a tron-typed network + nothing already
// listening). Side-effect import — registers the TASK_TEST wrapper.
require('./tasks/test');

// Auto-spawn a TRE container on `hardhat compile` when
// `tre.autoStartOnCompile` is true (opt-in; default false).
require('./tasks/compile');

// Auto-spawn a TRE container on `hardhat node`. Default-on via
// `tre.autoStartOnNode`. Does not tear down — `node` is
// long-running, the user manages cleanup with `docker rm -f`.
require('./tasks/node');

const { extendEnvironment } = require('hardhat/config');

const treWeb = require('./runtime/tre-web');
const cheatcodes = require('./runtime/cheatcodes');
const deploy = require('./runtime/deploy');
const wait = require('./runtime/wait');
const artifacts = require('./runtime/artifacts');
const instanceIds = require('./runtime/instance-id');

// Side-effect import: registers an `extendEnvironment` hook that
// overrides `hre.ethers.deployContract` so unmodified ethers-based
// tests can deploy through TronWeb.
require('./runtime/ethers-bridge');

// Side-effect import: registers an `extendProvider` hook that answers
// `hardhat_metadata` on tron-typed networks so upgrades tooling keys its
// development manifests by TRE instance. See runtime/metadata-provider.js.
require('./runtime/metadata-provider');

extendEnvironment((hre) => {
  hre.tre = hre.tre || {};
  Object.assign(hre.tre, {
    makeTronWeb: () => treWeb.makeTronWeb(hre),
    instanceId: () => instanceIds.instanceId(hre),
    rpcCall: cheatcodes.rpcCall,
    mine: cheatcodes.mine,
    setBlockTime: cheatcodes.setBlockTime,
    snapshot: cheatcodes.snapshot,
    revert: cheatcodes.revert,
    setAccountBalance: cheatcodes.setAccountBalance,
    setAccountCode: cheatcodes.setAccountCode,
    setAccountStorageAt: cheatcodes.setAccountStorageAt,
    unlockAccounts: cheatcodes.unlockAccounts,
    deployContract: deploy.deployContract,
    prebuildDeploy: deploy.prebuildDeploy,
    submitPrebuilt: deploy.submitPrebuilt,
    waitForReceipt: wait.waitForReceipt,
    loadArtifact: artifacts.loadArtifact,
  });
});
