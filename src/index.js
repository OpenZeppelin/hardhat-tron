//
// @openzeppelin/hardhat-tron
//
// Hardhat plugin for compiling and deploying Solidity contracts onto
// the TRON TVM via a local java-tron (TRE) container. Pulls together
// three independent surfaces:
//
//   - compile/    tron-solc compile pipeline (subtask hooks +
//                 SHA-256-verified wasm downloader). Replaces
//                 @layerzerolabs/hardhat-tron with a tighter,
//                 single-source-of-truth design.
//
//   - runtime/    `hre.tre.*` helpers (TronWeb wrapper, cheatcodes,
//                 deploy bridge, signers, time-warp, http keep-alive)
//                 plus an `hre.ethers.*` override that routes deploys
//                 through TronWeb so unmodified ethers-based tests can
//                 run against TRE.
//
//   - tre/        Container lifecycle (docker run/stop, readiness
//                 polling) used by the auto-up task wrappers.
//
//   - tasks/      Task wrappers that spin TRE up before `compile`,
//                 `test`, `node` when `tre.autoStart === true` and a
//                 TRE is not already responding on `network.tre.url`.
//
// Importing this module is consent. There is no `enable` flag.
// Disable specific subsystems via:
//   tre.compiler.disabled = true
//   tre.autoStart = false
//

// HTTP keep-alive MUST install before any other module loads TronWeb /
// axios -- those create their HTTP-agent instances at construction
// time and won't pick up a globalAgent change after the fact.
require('./runtime/http-agent');

// Compile pipeline (extendConfig + subtask hooks).
require('./compile');

const { extendEnvironment } = require('hardhat/config');

const cheatcodes = require('./runtime/cheatcodes');
const treWeb = require('./runtime/tre-web');
const deploy = require('./runtime/deploy');
const wait = require('./runtime/wait');
const artifacts = require('./runtime/artifacts');
const bridge = require('./runtime/ethers-bridge');

extendEnvironment(hre => {
  hre.tre = hre.tre || {};
  Object.assign(hre.tre, {
    makeTronWeb: () => treWeb.makeTronWeb(hre),
    rpcCall: cheatcodes.rpcCall,
    mine: cheatcodes.mine,
    setBlockTime: cheatcodes.setBlockTime,
    enableInstamine: cheatcodes.enableInstamine,
    setAccountBalance: cheatcodes.setAccountBalance,
    setAccountCode: cheatcodes.setAccountCode,
    setAccountStorageAt: cheatcodes.setAccountStorageAt,
    unlockAccounts: cheatcodes.unlockAccounts,
    snapshot: cheatcodes.snapshot,
    revert: cheatcodes.revert,
    deployContract: deploy.deployContract,
    prebuildDeploy: deploy.prebuildDeploy,
    submitPrebuilt: deploy.submitPrebuilt,
    waitForReceipt: wait.waitForReceipt,
    loadArtifact: artifacts.loadArtifact,
    tronToHex: bridge.tronToHex,
    toTronBase58: bridge.toTronBase58,
  });
});

// Side-effect of require('./runtime/ethers-bridge') (already happened
// above): registers an extendEnvironment hook that overrides
// hre.ethers.{deployContract, getContractFactory, getSigners,
// getContractAt, provider} to route through TronWeb. Lazy references
// to hre.tre.* mean registration order is not load-bearing.

// Lifecycle config + task wrappers. The task wrappers each check
// `tre.autoStart` and an already-listening TRE before doing anything,
// so they're safe to register unconditionally.
require('./tre/config');
require('./tasks/test');
require('./tasks/compile');
require('./tasks/node');
require('./tasks/tron-compile-batches');
