'use strict';

// Proves containerServing can identify the docker container publishing a
// url's host port from outside the ownership path (`_launched`) — the
// capability any local process needs to derive a container-based identity
// for a TRE it did not itself spawn. Non-docker guard tests run always;
// the integration test is docker-gated like the rest of the lifecycle suite.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { expect } = require('chai');

const lifecycle = require('../src/tre/lifecycle');
const instanceIds = require('../src/runtime/instance-id');

const PORT = Number(process.env.TRE_DISCOVERY_TEST_PORT || 9494);
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

// Bare EIP-1193-style provider for the genesis fallback path — plain JSON-RPC,
// no key, mirroring what instance-id receives from the network provider.
const rpcProvider = {
  async request({ method, params }) {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  },
};

// Pure host/port matching rules — no docker involved. Mirrors what docker
// inspect reports: Ports keyed by container-side port, bindings carrying the
// HostIp exactly as bound (no brackets on IPv6), url hosts as URL.hostname
// yields them (brackets kept on IPv6).
describe('binding host matching (pure)', function () {
  const ports = (ip, containerPort = '9090/tcp', hostPort = '9494') => ({
    [containerPort]: [{ HostIp: ip, HostPort: hostPort }],
  });

  it('matches a literal IPv4 url host against the same HostIp', function () {
    expect(lifecycle.bindsHostPort(ports('127.0.0.1'), '9494', '127.0.0.1')).to.equal(true);
  });

  it('does not match a different loopback address', function () {
    expect(lifecycle.bindsHostPort(ports('127.0.0.1'), '9494', '127.0.0.2')).to.equal(false);
    expect(lifecycle.hostMatchesBinding('127.0.0.2', '127.0.0.1')).to.equal(false);
  });

  it('matches a bracketed IPv6 url host against the unbracketed HostIp', function () {
    expect(lifecycle.bindsHostPort(ports('::1'), '9494', '[::1]')).to.equal(true);
    expect(lifecycle.hostMatchesBinding('[::1]', '::1')).to.equal(true);
  });

  it('does not match across address families for literal hosts', function () {
    expect(lifecycle.hostMatchesBinding('[::1]', '127.0.0.1')).to.equal(false);
    expect(lifecycle.hostMatchesBinding('127.0.0.1', '::1')).to.equal(false);
  });

  it('wildcard bindings match any url host', function () {
    for (const wildcard of ['', '0.0.0.0', '::']) {
      expect(lifecycle.hostMatchesBinding('127.0.0.1', wildcard)).to.equal(true);
      expect(lifecycle.hostMatchesBinding('127.0.0.2', wildcard)).to.equal(true);
      expect(lifecycle.hostMatchesBinding('[::1]', wildcard)).to.equal(true);
      expect(lifecycle.hostMatchesBinding('localhost', wildcard)).to.equal(true);
    }
  });

  it('an unspecified url host (localhost) matches any loopback binding', function () {
    expect(lifecycle.hostMatchesBinding('localhost', '127.0.0.1')).to.equal(true);
    expect(lifecycle.hostMatchesBinding('localhost', '127.0.0.3')).to.equal(true);
    expect(lifecycle.hostMatchesBinding('localhost', '::1')).to.equal(true);
  });

  it('excludes bindings whose container-side port is not the TRE 9090/tcp', function () {
    // A forwarder publishing the right host port from the wrong internal port.
    expect(lifecycle.bindsHostPort(ports('127.0.0.1', '80/tcp'), '9494', '127.0.0.1')).to.equal(false);
    expect(lifecycle.bindsHostPort(ports('127.0.0.1', '9494/tcp'), '9494', '127.0.0.1')).to.equal(false);
  });

  it('requires the host port to match on the 9090/tcp binding', function () {
    expect(lifecycle.bindsHostPort(ports('127.0.0.1', '9090/tcp', '9595'), '9494', '127.0.0.1')).to.equal(false);
  });
});

describe('containerServing url guards', function () {
  it('returns undefined for a non-loopback url', function () {
    expect(lifecycle.containerServing('http://10.0.0.5:9090/jsonrpc')).to.equal(undefined);
  });
  it('returns undefined for an unparseable url', function () {
    expect(lifecycle.containerServing('not a url')).to.equal(undefined);
  });
  it('returns undefined when DOCKER_HOST is remote', function () {
    const prev = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'tcp://build-farm:2376';
    try {
      expect(lifecycle.containerServing('http://127.0.0.1:9090/jsonrpc')).to.equal(undefined);
    } finally {
      if (prev === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = prev;
    }
  });
});

describe('containerServing docker integration', function () {
  it('discovers the launched container and reproduces the ownership-path id (docker)', async function () {
    if (!dockerAvailable()) this.skip();
    this.timeout(120000);
    const cfg = makeCfg('hardhat-tron-discover');
    const up = await lifecycle.ensureUp(cfg, URL, () => {});
    try {
      const found = lifecycle.containerServing(URL);
      expect(found).to.be.an('object');
      // Same identity the ownership path hashes: docker id + StartedAt.
      const ownedId = await instanceIds.instanceId({ networkName: 'tre', url: URL, provider: rpcProvider });
      const rehash = '0x' + crypto.createHash('sha256').update(`${found.id}|${found.startedAt}`).digest('hex');
      expect(rehash).to.equal(ownedId);
    } finally {
      lifecycle.teardown(up.name);
    }
  });

  it('returns undefined for an unbound loopback port (docker)', function () {
    if (!dockerAvailable()) this.skip();
    expect(lifecycle.containerServing('http://127.0.0.1:1/jsonrpc')).to.equal(undefined);
  });

  it('does not discover a forwarder-style container publishing the port from a non-TRE internal port (docker)', function () {
    if (!dockerAvailable()) this.skip();
    this.timeout(60000);
    const name = 'hardhat-tron-fwd-fingerprint';
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    // nginx listens on 80 inside; publishing 127.0.0.1:PORT:80 is the shape of
    // a port-forwarder/proxy in front of the url — same host port, wrong
    // container port. The fingerprint must reject it.
    const run = spawnSync('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${PORT}:80`, 'nginx:alpine'], {
      encoding: 'utf8',
    });
    if (run.status !== 0) this.skip(); // image not available locally and not pullable
    try {
      expect(lifecycle.containerServing(URL)).to.equal(undefined);
    } finally {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
  });
});
