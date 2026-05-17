//
// src/tasks/node.js
//
// Wraps TASK_NODE so `npx hardhat node` brings TRE up but DOES NOT
// tear it down on exit. Two differences vs tasks/test.js:
//
//   1. Auto-start gates on `tre.autoStartOnNode` (default true).
//      Running `hardhat node` against a tron network without a TRE
//      is nearly always a mistake.
//
//   2. We force `keepRunning` semantics for the duration of the
//      `node` lifecycle -- the user explicitly wants a long-running
//      dev environment. SIGINT teardown is the user's responsibility
//      (the standard `docker rm -f <name>` or `npm run tre:down`).
//

const { task } = require('hardhat/config');
const { TASK_NODE } = require('hardhat/builtin-tasks/task-names');

const lifecycle = require('../tre/lifecycle');

function shouldAutoStart(hre) {
  const tre = hre.config.tre;
  if (!tre || !tre.autoStart) return false;
  if (tre.autoStartOnNode === false) return false;
  const net = hre.network && hre.network.config;
  return !!(net && net.tron);
}

task(TASK_NODE).setAction(async (args, hre, runSuper) => {
  if (!shouldAutoStart(hre)) {
    return runSuper(args);
  }
  const log = msg => console.log(`[hardhat-tron] ${msg}`);
  const spawned = await lifecycle.ensureUp(hre.config.tre, hre.network.config.url, log);
  if (spawned.spawned) {
    log(`  ${spawned.name} will stay running after this process exits (docker rm -f to clean up)`);
  }
  // Do not wrap the runSuper call in try/finally -- node is long-
  // running, the user manages teardown.
  return runSuper(args);
});
