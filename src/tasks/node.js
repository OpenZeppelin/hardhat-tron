'use strict';

// Wraps `TASK_NODE` so `npx hardhat node` brings TRE up but does
// NOT tear it down on exit. Two differences vs. the `test`
// wrapper:
//
//   1. Auto-start gates on `tre.autoStartOnNode` (default `true`).
//      Running `hardhat node` against a tron network without a
//      TRE is nearly always a mistake.
//
//   2. `keepRunning` semantics are enforced for the lifetime of
//      the `node` process — the user explicitly wants a
//      long-running dev environment. SIGINT teardown is the
//      user's responsibility (`docker rm -f <name>`).

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
  const log = (msg) => console.log(`[hardhat-tron] ${msg}`);
  const spawned = await lifecycle.ensureUp(hre.config.tre, hre.network.config.url, log);
  if (spawned.spawned) {
    log(`  ${spawned.name} will stay running after this process exits (docker rm -f to clean up)`);
  }
  // Do not wrap the runSuper call in try/finally -- node is long-
  // running, the user manages teardown.
  return runSuper(args);
});
