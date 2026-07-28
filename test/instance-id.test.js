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
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { expect } = require('chai');

const lifecycle = require('../src/tre/lifecycle');
const instanceIds = require('../src/runtime/instance-id');
const treWeb = require('../src/runtime/tre-web');

const PORT = Number(process.env.TRE_INSTANCE_TEST_PORT || 9393);
const URL = `http://127.0.0.1:${PORT}/jsonrpc`;
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Resolved relative to this file, not process.cwd(), so the jar-gate works
// regardless of where `npm test` was invoked from.
const JAR_PATH = path.join(__dirname, '..', 'tre', 'FullNode.jar');

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

// A minimal hre-shape carrying just what tre-web reads.
const hreShim = {
  network: { name: 'tre', config: { url: URL, accounts: [PRIVATE_KEY] } },
};

// Bare EIP-1193-style provider for the genesis fallback path — plain JSON-RPC,
// no key, mirroring what instance-id receives from the network provider.
function makeRpcProvider(url) {
  return {
    async request({ method, params }) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    },
  };
}
const rpcProvider = makeRpcProvider(URL);

// Serves one scripted handler per request index; requests beyond the script
// reuse the last entry. Lets a test express "reset once, then answer".
async function scriptedServer(script) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    script[Math.min(hits++, script.length - 1)](req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/jsonrpc`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const resetConn = (req) => (req.socket.resetAndDestroy ? req.socket.resetAndDestroy() : req.socket.destroy());
const serveId = (id) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }));
};
const serveHtml = (req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end('<html>not found</html>');
};

function countingGenesisProvider(hash) {
  let calls = 0;
  return {
    calls: () => calls,
    async request({ method }) {
      if (method === 'eth_getBlockByNumber') {
        calls++;
        return { hash };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

async function bootCaptureTeardown(containerName) {
  const cfg = makeCfg(containerName);
  const spawned = await lifecycle.ensureUp(cfg, URL, () => {});
  try {
    const id = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
    const { tronWeb } = treWeb.makeTronWeb(hreShim);
    const genesis = await tronWeb.trx.getBlock(0);
    return { id, spawned: spawned.spawned, genesisId: genesis && genesis.blockID };
  } finally {
    if (spawned.name) lifecycle.teardown(spawned.name, () => {});
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

  it('serves a fresh id after teardown + reboot on the same url (no manual cache clearing)', async function () {
    this.timeout(300_000);
    const cfgA = makeCfg('hardhat-tron-evict-a');
    const a = await lifecycle.ensureUp(cfgA, URL, () => {});
    let idA;
    try {
      idA = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
    } finally {
      lifecycle.teardown(a.name);
    }
    const cfgB = makeCfg('hardhat-tron-evict-b');
    const b = await lifecycle.ensureUp(cfgB, URL, () => {});
    try {
      const idB = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      expect(idB).to.not.equal(idA);
    } finally {
      lifecycle.teardown(b.name);
    }
  });

  it('resolves the same id for a process that did not launch the container (docker)', async function () {
    if (!dockerAvailable()) this.skip();
    this.timeout(120000);
    const cfg = makeCfg('hardhat-tron-foreign');
    const up = await lifecycle.ensureUp(cfg, URL, () => {});
    try {
      const ownedId = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      // Simulate a foreign process: no ownership record, no memoized id.
      lifecycle._forgetLaunchedForTests(URL);
      instanceIds.evictInstanceId(URL);
      const foreignId = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      expect(foreignId).to.equal(ownedId);
      const genesis = await rpcProvider.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] });
      expect(foreignId).to.not.equal(genesis.hash);
    } finally {
      lifecycle.teardown(up.name);
      instanceIds.evictInstanceId(URL);
    }
  });

  it('gives two foreign-observed instances different ids (docker)', async function () {
    if (!dockerAvailable()) this.skip();
    this.timeout(240000);
    const URL_B = `http://127.0.0.1:${PORT + 1}/jsonrpc`;
    const cfgA = makeCfg('hardhat-tron-par-a');
    const cfgB = { ...makeCfg('hardhat-tron-par-b'), port: PORT + 1 };
    const a = await lifecycle.ensureUp(cfgA, URL, () => {});
    const b = await lifecycle.ensureUp(cfgB, URL_B, () => {});
    try {
      lifecycle._forgetLaunchedForTests(URL);
      lifecycle._forgetLaunchedForTests(URL_B);
      instanceIds.evictInstanceId(URL);
      instanceIds.evictInstanceId(URL_B);
      const idA = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      const idB = await instanceIds.instanceId({ networkName: 'tre', url: URL_B, provider: makeRpcProvider(URL_B) });
      expect(idA).to.not.equal(idB);
    } finally {
      lifecycle.teardown(a.name);
      lifecycle.teardown(b.name);
      instanceIds.evictInstanceId(URL);
      instanceIds.evictInstanceId(URL_B);
    }
  });

  it('prefers the node-served id and gives every observer the same value (docker + patched jar)', async function () {
    if (!dockerAvailable() || !fs.existsSync(JAR_PATH)) this.skip();
    this.timeout(120000);
    const cfg = { ...makeCfg('hardhat-tron-tier0'), jarPath: JAR_PATH };
    const up = await lifecycle.ensureUp(cfg, URL, () => {});
    try {
      const ownedId = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      expect(ownedId).to.match(/^0x[0-9a-f]{64}$/);
      // Tier 0 is what the node itself serves, not a container-derived hash --
      // pin the owned path to the same direct fetch a docker-blind caller would make.
      const direct = await fetch(URL.replace(/\/jsonrpc$/, '/tre'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tre_instanceId', params: [] }),
      }).then((r) => r.json());
      expect(ownedId).to.equal(direct.result);
      // A docker-blind foreign observer resolves the same id over RPC alone.
      lifecycle._forgetLaunchedForTests(URL);
      instanceIds.evictInstanceId(URL);
      const foreignId = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      expect(foreignId).to.equal(ownedId);
      const genesis = await rpcProvider.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] });
      expect(ownedId).to.not.equal(genesis.hash);
    } finally {
      lifecycle.teardown(up.name);
      instanceIds.evictInstanceId(URL);
    }
  });
});

describe('owned-container identity failures', function () {
  const OWNED_URL = 'http://127.0.0.1:19553/jsonrpc';
  afterEach(function () {
    lifecycle._forgetLaunchedForTests(OWNED_URL);
    instanceIds.evictInstanceId(OWNED_URL);
  });
  it('throws instead of falling back when the launched container cannot be inspected', async function () {
    lifecycle._setLaunchedForTests(OWNED_URL, 'hardhat-tron-no-such-container');
    try {
      await instanceIds.instanceId({ networkName: 'tre', url: OWNED_URL, provider: rpcProvider });
      throw new Error('expected instanceId to throw');
    } catch (e) {
      expect(e.message).to.contain('hardhat-tron-no-such-container');
      // docker's own stderr (or the spawn error) must be surfaced, not the
      // old generic placeholder. Asserted shape-wise, not text-wise: the
      // exact stderr differs across docker versions and daemon states
      // ("No such object", "Cannot connect...", ENOENT without docker).
      expect(e.message).to.match(/could not read its docker identity: \S/);
      expect(e.message).to.not.contain('(docker inspect failed)');
    }
  });
});

// No docker gating: a plain node:http server stands in for a stock TRE node
// answering /tre with a parsed JSON-RPC error -- the definitive "tier 0 does
// not apply" case, as opposed to a thrown probe failure.
describe('nodeServedInstanceId: stock-node answer vs probe failure', function () {
  it('returns undefined without retry when the node answers with a JSON-RPC error, falling through to genesis', async function () {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/jsonrpc`;
    const genesisHash = '0x' + 'ab'.repeat(32);
    const genesisProvider = {
      async request({ method }) {
        if (method === 'eth_getBlockByNumber') return { hash: genesisHash };
        throw new Error(`unexpected method ${method}`);
      },
    };
    try {
      const id = await instanceIds.instanceId({ networkName: 'tre', url, provider: genesisProvider });
      expect(id).to.equal(genesisHash);
      expect(hits).to.equal(1);
    } finally {
      instanceIds.evictInstanceId(url);
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('nodeServedInstanceId: transient failures vs definitive answers', function () {
  const SERVED_ID = '0x' + 'cd'.repeat(32);
  const GENESIS = '0x' + 'ab'.repeat(32);
  let savedDockerHost;
  before(function () {
    savedDockerHost = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'tcp://stub:2376';
  });
  after(function () {
    if (savedDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = savedDockerHost;
  });

  it('recovers from a single connection reset within one call and resolves the served id', async function () {
    const srv = await scriptedServer([resetConn, serveId(SERVED_ID)]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      const id = await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis });
      expect(id).to.equal(SERVED_ID);
      expect(srv.hits()).to.equal(2);
      expect(genesis.calls()).to.equal(0);
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('treats a non-JSON body as a definitive answer and does not retry', async function () {
    const srv = await scriptedServer([serveHtml]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      const id = await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis });
      expect(id).to.equal(GENESIS);
      expect(srv.hits()).to.equal(1);
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('treats a 429 from an intermediary as transient and retries', async function () {
    const srv = await scriptedServer([
      (req, res) => {
        res.writeHead(429, { 'Content-Type': 'text/html' });
        res.end('<html>slow down</html>');
      },
      serveId(SERVED_ID),
    ]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      const id = await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis });
      expect(id).to.equal(SERVED_ID);
      expect(srv.hits()).to.equal(2);
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('converges on the served id on a later call when the whole first probe fails', async function () {
    const srv = await scriptedServer([resetConn, resetConn, serveId(SERVED_ID)]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(SERVED_ID);
      const after = srv.hits();
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(SERVED_ID);
      expect(srv.hits()).to.equal(after); // now definitively cached
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('re-probes tier 0 only: the fallback tiers are not re-resolved on provisional calls', async function () {
    const srv = await scriptedServer([resetConn]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      expect(srv.hits()).to.equal(2);
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      expect(srv.hits()).to.equal(4);
      expect(genesis.calls()).to.equal(1); // tiers 1-3 ran exactly once
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('settles after a bounded number of failed re-probes, warning once', async function () {
    const srv = await scriptedServer([resetConn]);
    const genesis = countingGenesisProvider(GENESIS);
    const warns = [];
    const origWarn = console.warn;
    console.warn = (m) => warns.push(String(m));
    try {
      for (let i = 0; i < 5; i++) {
        expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      }
      expect(srv.hits()).to.equal(6); // 2 attempts x (1 initial + 2 re-probes), then settled
      expect(warns.filter((w) => w.includes('tre_instanceId')).length).to.equal(1);
    } finally {
      console.warn = origWarn;
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('coalesces concurrent calls onto one resolution', async function () {
    const srv = await scriptedServer([resetConn, serveId(SERVED_ID)]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      const [a, b] = await Promise.all([
        instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis }),
        instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis }),
      ]);
      expect(a).to.equal(SERVED_ID);
      expect(b).to.equal(SERVED_ID);
      expect(srv.hits()).to.equal(2); // one shared probe run, not two
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('eviction clears provisional state so a fresh boot re-resolves from scratch', async function () {
    const srv = await scriptedServer([resetConn]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      instanceIds.evictInstanceId(srv.url);
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      expect(genesis.calls()).to.equal(2); // full re-resolution, not a tier-0 re-probe
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });

  it('caches a definitive method-not-found answer and never re-probes it', async function () {
    const srv = await scriptedServer([
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }));
      },
    ]);
    const genesis = countingGenesisProvider(GENESIS);
    try {
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      expect(await instanceIds.instanceId({ networkName: 'tre', url: srv.url, provider: genesis })).to.equal(GENESIS);
      expect(srv.hits()).to.equal(1);
      expect(genesis.calls()).to.equal(1);
    } finally {
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });
});

describe('provisional resolution over an owned container (docker)', function () {
  const NAME = 'hardhat-tron-provisional-test';
  before(function () {
    if (!dockerAvailable()) this.skip();
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    const r = spawnSync('docker', ['run', '-d', '--name', NAME, 'alpine', 'sleep', '60'], { encoding: 'utf8' });
    if (r.status !== 0) this.skip();
  });
  after(function () {
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  });

  it('does not commit to the container-derived id after a failed probe', async function () {
    const SERVED_ID = '0x' + 'ee'.repeat(32);
    const srv = await scriptedServer([resetConn, resetConn, serveId(SERVED_ID)]);
    lifecycle._setLaunchedForTests(srv.url, NAME);
    try {
      const first = await instanceIds.instanceId({
        networkName: 'tre',
        url: srv.url,
        provider: countingGenesisProvider('0x00'),
      });
      expect(first).to.match(/^0x[0-9a-f]{64}$/);
      expect(first).to.not.equal(SERVED_ID);
      const second = await instanceIds.instanceId({
        networkName: 'tre',
        url: srv.url,
        provider: countingGenesisProvider('0x00'),
      });
      expect(second).to.equal(SERVED_ID);
    } finally {
      lifecycle._forgetLaunchedForTests(srv.url);
      instanceIds.evictInstanceId(srv.url);
      await srv.close();
    }
  });
});
