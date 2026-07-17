'use strict';

// Proves the per-instance id distinguishes two sequentially booted, otherwise
// identical TRE containers — the property the genesis-hash derivation could not
// provide, since a TRE booted from the same config produces the same genesis
// block every time.
//
// Docker-gated like the e2e suite: skipped when docker is unavailable so CI
// without a container runtime stays green. To exercise locally:
//
//   npm test    # with a working docker daemon and the tronbox/tre:dev image
//
// It boots a fresh container, captures its id, tears it down, boots another on
// the same port, and asserts the two ids differ while the genesis blocks match.

const { spawnSync } = require('node:child_process');
const { expect } = require('chai');

const lifecycle = require('../src/tre/lifecycle');
const instanceIds = require('../src/runtime/instance-id');
const treWeb = require('../src/runtime/tre-web');

const PORT = Number(process.env.TRE_INSTANCE_TEST_PORT || 9393);
const URL = `http://127.0.0.1:${PORT}/jsonrpc`;
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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

// A minimal hre-shape carrying just what instance-id / tre-web read.
const hreShim = {
  network: { name: 'tre', config: { url: URL, accounts: [PRIVATE_KEY] } },
};

async function bootCaptureTeardown(containerName) {
  const cfg = makeCfg(containerName);
  const spawned = await lifecycle.ensureUp(cfg, URL, () => {});
  try {
    instanceIds._clearCache();
    const id = await instanceIds.instanceId(hreShim);
    const { tronWeb } = treWeb.makeTronWeb(hreShim);
    const genesis = await tronWeb.trx.getBlock(0);
    return { id, spawned: spawned.spawned, genesisId: genesis && genesis.blockID };
  } finally {
    if (spawned.name) lifecycle.teardown(spawned.name, () => {});
    instanceIds._clearCache();
  }
}

describe('TRE instance id across sequential boots', function () {
  let first;
  let second;

  before(async function () {
    if (!dockerAvailable()) {
      // eslint-disable-next-line no-console
      console.log('  [skip] docker unavailable — start docker to run the instance-id boot test');
      this.skip();
    }
    this.timeout(300_000);
    // Distinct container names so a leftover from a crashed run cannot be reused
    // across the two boots and mask a difference.
    first = await bootCaptureTeardown('hardhat-tron-instance-id-test-a');
    second = await bootCaptureTeardown('hardhat-tron-instance-id-test-b');
  });

  it('derives the id from the launched container, not the genesis hash', function () {
    // Both boots were launched by the plugin, so both ids are the hashed
    // container identity (0x + sha256 hex), not the genesis-hash fallback.
    expect(first.spawned).to.equal(true);
    expect(second.spawned).to.equal(true);
    expect(first.id).to.match(/^0x[0-9a-f]{64}$/);
    expect(second.id).to.match(/^0x[0-9a-f]{64}$/);
  });

  it('yields different ids for two fresh instances even with identical genesis', function () {
    // The genesis block is byte-for-byte identical across the two boots — which
    // is exactly why the genesis hash could not tell them apart — yet the
    // container-derived ids differ.
    expect(second.genesisId).to.equal(first.genesisId);
    expect(second.id).to.not.equal(first.id);
    // And neither id is merely the genesis-hash fallback for this instance.
    expect(first.id).to.not.equal(`0x${first.genesisId}`);
    expect(second.id).to.not.equal(`0x${second.genesisId}`);
  });
});
