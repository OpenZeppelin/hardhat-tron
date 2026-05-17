//
// src/tasks/compile.js
//
// Wraps TASK_COMPILE so `npx hardhat compile` auto-spawns TRE when
// needed. In practice the compile pipeline itself does not talk to a
// running TRE -- tron-solc compiles wasm-locally -- but Hardhat's
// task graph initialises the network connection at compile time
// (network-typed config validation, `chainId` probe under some
// plugins), and we want the auto-up promise to extend to every
// hardhat invocation that touches a tron-typed network.
//
// Identical activation rules to tasks/test.js. See that file for the
// rationale.
//

const { task } = require('hardhat/config');
const { TASK_COMPILE } = require('hardhat/builtin-tasks/task-names');

const lifecycle = require('../tre/lifecycle');

function shouldAutoStart(hre) {
  const tre = hre.config.tre;
  if (!tre || !tre.autoStart) return false;
  // Compile does NOT need a running TRE for the actual solc work.
  // We only auto-start if the user has tre.autoStartOnCompile (default
  // false to avoid spinning a 1-2 GB Java container for a 30-second
  // compile). Tests need it; compile usually doesn't.
  if (!tre.autoStartOnCompile) return false;
  const net = hre.network && hre.network.config;
  return !!(net && net.tron);
}

task(TASK_COMPILE).setAction(async (args, hre, runSuper) => {
  if (!shouldAutoStart(hre)) {
    return runSuper(args);
  }

  const log = msg => console.log(`[hardhat-tron] ${msg}`);
  const url = hre.network.config.url;

  let spawned;
  try {
    spawned = await lifecycle.ensureUp(hre.config.tre, url, log);
  } catch (e) {
    console.error(`[hardhat-tron] failed to bring TRE up: ${e.message}`);
    throw e;
  }

  try {
    return await runSuper(args);
  } finally {
    if (spawned.spawned && !hre.config.tre.keepRunning) {
      lifecycle.teardown(spawned.name, log);
    }
  }
});
