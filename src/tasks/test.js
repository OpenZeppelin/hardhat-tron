//
// src/tasks/test.js
//
// Wraps TASK_TEST so `npx hardhat test` auto-spawns a TRE container
// before tests run and tears it down after, when the configured
// network is tron-typed AND `tre.autoStart` is true.
//
// Skip cases (no spawn):
//   * tre.autoStart === false
//   * The selected network does not have `tron: true`
//   * Something is already responding on `network.<n>.url` (manual
//     `docker-compose up -d`, an external service, or a previous run
//     left up by tre.keepRunning)
//
// Teardown: skipped if cfg.keepRunning is true, OR if the
// pre-existing container was reused (we didn't spawn it, we don't
// own it).
//

const { task } = require('hardhat/config');
const { TASK_TEST } = require('hardhat/builtin-tasks/task-names');

const lifecycle = require('../tre/lifecycle');

function shouldAutoStart(hre) {
  const tre = hre.config.tre;
  if (!tre || !tre.autoStart) return false;
  if (tre.autoStartOnTest === false) return false;
  const net = hre.network && hre.network.config;
  return !!(net && net.tron);
}

task(TASK_TEST).setAction(async (args, hre, runSuper) => {
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
    } else if (spawned.spawned) {
      log(`  leaving ${spawned.name} running (tre.keepRunning=true)`);
    }
  }
});
