'use strict';

// End-to-end deploy + call against a running TRE container. Skipped
// when no TRE is reachable on `TRE_URL` (default
// http://127.0.0.1:9090/jsonrpc) so CI without Docker runs clean
// and local development without a container up also runs clean. To
// exercise the full path locally:
//
//   docker run -d -p 9090:9090 tronbox/tre:dev
//   npm test
//
// or any equivalent that brings a TRE container up on the
// configured port.

const path = require('node:path');
const { expect } = require('chai');

const lifecycle = require('../src/tre/lifecycle');
const { isReachable } = lifecycle;

// True only if tier 0 (node-served) would actually answer for this url —
// independent of whether *some* docker daemon happens to be reachable.
async function tier0Answers(url) {
  try {
    const res = await fetch(url.replace(/\/jsonrpc$/, '/tre'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tre_instanceId', params: [] }),
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json());
    return typeof res.result === 'string' && /^0x[0-9a-f]{64}$/.test(res.result);
  } catch {
    return false;
  }
}

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'minimal');
const TRE_URL = process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc';

describe('end-to-end against a running TRE', function () {
  let hre;

  before(async function () {
    if (!(await isReachable(TRE_URL))) {
      // eslint-disable-next-line no-console
      console.log(`  [skip] no TRE reachable at ${TRE_URL} — start one to run the e2e tests`);
      this.skip();
    }

    // Hardhat reads its config from the current working directory's
    // `hardhat.config.*` by default; point it at the fixture so the
    // plugin's relative `require('../../../src')` resolves to the
    // sources under development.
    process.chdir(FIXTURE_DIR);
    process.env.HARDHAT_CONFIG = path.join(FIXTURE_DIR, 'hardhat.config.cjs');
    process.env.HARDHAT_NETWORK = 'tre';

    // Bust any cached hardhat module — other tests in the same mocha
    // process may have loaded it against a different config.
    delete require.cache[require.resolve('hardhat')];
    hre = require('hardhat');
    await hre.run('compile');
  });

  it('hre.tre is wired with the runtime surface', function () {
    expect(hre.tre).to.be.an('object');
    expect(hre.tre.makeTronWeb).to.be.a('function');
    expect(hre.tre.deployContract).to.be.a('function');
    expect(hre.tre.waitForReceipt).to.be.a('function');
    expect(hre.tre.loadArtifact).to.be.a('function');
    expect(hre.tre.instanceId).to.be.a('function');
  });

  it('exposes a stable per-instance id for this external TRE', async function () {
    // This suite runs against a TRE it did not launch (autoStart is off and the
    // node is merely reachable). Resolution still goes through the full tier
    // chain: a patched node answers tier 0 directly; otherwise, if docker can
    // see a container publishing this port, tier 2 discovers it; only with
    // neither does this fall back to the genesis hash (tier 3).
    const id = await hre.tre.instanceId();
    expect(id).to.match(/^0x[0-9a-f]{64}$/);
    // A first-probe hiccup could converge the id once here (see instance-id.js); against a healthy local node this is stable.
    // Cached and stable: repeated calls return the same value.
    expect(await hre.tre.instanceId()).to.equal(id);
    const { tronWeb } = hre.tre.makeTronWeb();
    const genesis = await tronWeb.trx.getBlock(0);
    // Only assert the inequality when a stronger-than-genesis source is
    // confirmed for THIS url (tier 0 answers, or docker discovers it) —
    // an unrelated local docker daemon proves nothing about this TRE.
    let discovered;
    try {
      discovered = lifecycle.containerServing(TRE_URL);
    } catch {
      discovered = undefined; // ambiguous — treat as not attributable and skip
    }
    if ((await tier0Answers(TRE_URL)) || discovered) {
      expect(id).to.not.contain(genesis.blockID);
    }
  });

  it('answers hardhat_metadata on the network provider with the instance id', async function () {
    // upgrades tooling probes hardhat_metadata to key its per-instance
    // manifests. The reported chainId must match eth_chainId and the instanceId
    // must be the same value hre.tre.instanceId() resolves.
    const provider = hre.network.provider;
    const md = await provider.send('hardhat_metadata', []);
    expect(md).to.be.an('object');
    expect(md.chainId).to.be.a('number');
    const chainHex = await provider.send('eth_chainId', []);
    expect(md.chainId).to.equal(parseInt(chainHex.replace(/^0x/, ''), 16));
    expect(md.instanceId).to.equal(await hre.tre.instanceId());
  });

  it('deploys a contract via hre.ethers.deployContract and reads constructor state', async function () {
    const greeter = await hre.ethers.deployContract('Greeter', ['hello']);
    await greeter.waitForDeployment();
    expect(greeter.target).to.be.a('string');
    const greeting = await greeter.greeting();
    expect(greeting).to.equal('hello');
  });

  it('writes via a state-changing method and reads the new value back', async function () {
    const greeter = await hre.ethers.deployContract('Greeter', ['initial']);
    await greeter.waitForDeployment();
    const tx = await greeter.setGreeting('updated');
    await tx.wait();
    expect(await greeter.greeting()).to.equal('updated');
  });
});
