'use strict';

// Proves ensureUp replaces a STOPPED leftover named container with a fresh
// `docker run` instead of restarting it. TRE containers are single-boot (the
// image corrupts its own fullnode.conf on every start), so a restart path can
// never produce a working node — it burns the readiness timeout and, with
// keepRunning, wedges every later run. A RUNNING name-squatter is the
// opposite case: it may be a sibling process's node still booting, so it must
// survive and the name conflict must surface loudly. Docker-gated like the
// rest of the lifecycle suite.

const { spawnSync } = require('node:child_process');
const { expect } = require('chai');

const lifecycle = require('../src/tre/lifecycle');

const PORT = Number(process.env.TRE_ENSURE_UP_TEST_PORT || 9595);
const URL = `http://127.0.0.1:${PORT}/jsonrpc`;

function dockerAvailable() {
  const r = spawnSync('docker', ['version'], { encoding: 'utf8' });
  return r.status === 0;
}

function makeCfg(containerName) {
  return {
    image: process.env.TRE_IMAGE || 'tronbox/tre:dev',
    port: PORT,
    containerName,
    jarPath: null,
    keepRunning: false,
    readinessTimeoutMs: 90_000,
    startupEnv: {},
  };
}

describe('ensureUp with a leftover named container', function () {
  it('removes the stopped container and runs a fresh one instead of restarting it (docker)', async function () {
    if (!dockerAvailable()) this.skip();
    this.timeout(180_000);
    const name = 'hardhat-tron-single-boot-leftover';
    const cfg = makeCfg(name);
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    // `docker create` leaves a non-running container squatting on the name —
    // the state a prior keepRunning run leaves behind once its node exits.
    const created = spawnSync('docker', ['create', '--name', name, cfg.image], { encoding: 'utf8' });
    expect(created.status).to.equal(0, created.stderr);
    const staleId = created.stdout.trim();

    const up = await lifecycle.ensureUp(cfg, URL, () => {});
    try {
      expect(up.spawned).to.equal(true);
      expect(up.name).to.equal(name);
      // Fresh container, not the stale one restarted.
      const ins = spawnSync('docker', ['inspect', '--format', '{{.Id}}', name], { encoding: 'utf8' });
      expect(ins.status).to.equal(0);
      expect(ins.stdout.trim()).to.not.equal(staleId);
      // And the node actually serves — the restart path never got here.
      expect(await lifecycle.isReachable(URL)).to.equal(true);
    } finally {
      lifecycle.teardown(up.name);
    }
  });

  it('leaves a running name-squatter alone and fails loudly on the name conflict (docker)', async function () {
    if (!dockerAvailable()) this.skip();
    this.timeout(60_000);
    const name = 'hardhat-tron-running-squatter';
    const cfg = makeCfg(name);
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    // A running container that does not answer the TRE probe — the state of a
    // sibling process's node mid-boot (or any unrelated service on the name).
    const run = spawnSync('docker', ['run', '-d', '--name', name, '--entrypoint', 'sleep', cfg.image, 'infinity'], {
      encoding: 'utf8',
    });
    expect(run.status).to.equal(0, run.stderr);
    const squatterId = run.stdout.trim();
    try {
      let err;
      try {
        await lifecycle.ensureUp(cfg, URL, () => {});
      } catch (e) {
        err = e;
      }
      expect(err, 'ensureUp should surface the docker name conflict').to.exist;
      expect(err.message).to.contain('docker run failed');
      // The squatter survived, untouched and still running.
      const ins = spawnSync('docker', ['inspect', '--format', '{{.Id}} {{.State.Running}}', name], {
        encoding: 'utf8',
      });
      expect(ins.status).to.equal(0);
      expect(ins.stdout.trim()).to.equal(`${squatterId} true`);
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
  });
});
