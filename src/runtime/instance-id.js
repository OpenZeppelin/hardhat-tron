'use strict';

// A stable identifier for a specific TRE node instance.
//
// When this plugin launched the TRE container (via the lifecycle module on
// `hardhat test` / `node` / `compile`), the id is derived from the container's
// own identity — its docker container id plus the `StartedAt` timestamp,
// hashed. Both change on every fresh `docker run` and the timestamp also
// changes on every `docker start`, so the id distinguishes one boot from the
// next even when the chain is otherwise byte-for-byte deterministic.
//
// This replaces deriving the id from the genesis (block 0) hash: a TRE booted
// from the same config produces an identical genesis block on every restart, so
// the genesis hash cannot tell two deterministic restarts apart. It is kept
// only as a fallback for an externally-provided TRE — one this plugin did not
// launch (already reachable when a task started, a manual `docker-compose up`,
// or a parallel-test runner pointing at its own `TRE_URL`). In that case the
// container identity is unknown, so the genesis hash is used and two restarts
// of an external TRE with identical config will share an id. Consumers that
// need a guaranteed-fresh id per restart of an external TRE should let this
// plugin manage the container lifecycle.
//
// The id is immutable for the life of a node, so it is resolved once and cached
// per (network, url).

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const treWeb = require('./tre-web');
const lifecycle = require('../tre/lifecycle');

const _instanceIdCache = new Map();

// docker container id + StartedAt, hashed. Returns undefined if docker is
// unavailable, the container is unknown, or the fields could not be read — the
// caller then falls back to the genesis-derived id.
function containerInstanceId(containerName) {
  const r = spawnSync('docker', ['inspect', '--format', '{{.Id}}|{{.State.StartedAt}}', containerName], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return undefined;
  const raw = (r.stdout || '').trim();
  if (!raw || raw.includes('<no value>') || raw.startsWith('|') || raw.endsWith('|')) return undefined;
  return '0x' + crypto.createHash('sha256').update(raw).digest('hex');
}

async function genesisInstanceId(hre, url) {
  const { tronWeb } = treWeb.makeTronWeb(hre);
  const genesis = await tronWeb.trx.getBlock(0);
  const blockId = genesis && genesis.blockID;
  if (!blockId) {
    throw new Error(`Could not read the genesis block hash from ${url} to derive a TRE instance id.`);
  }
  return `0x${blockId}`;
}

async function instanceId(hre) {
  const url = hre.network.config.url;
  const cacheKey = `${hre.network.name}:${url}`;
  const cached = _instanceIdCache.get(cacheKey);
  if (cached) return cached;

  let id;
  const containerName = lifecycle.launchedContainerFor(url);
  if (containerName) {
    id = containerInstanceId(containerName);
  }
  if (!id) {
    // External TRE (this plugin did not launch the container) or docker
    // identity unavailable: fall back to the genesis hash. See the header note
    // on the limitation this carries for deterministic external restarts.
    id = await genesisInstanceId(hre, url);
  }

  _instanceIdCache.set(cacheKey, id);
  return id;
}

// Test-only: drop the memoized id so a suite that boots, tears down, and
// re-boots a TRE on the same url observes the new instance instead of the
// cached one.
function _clearCache() {
  _instanceIdCache.clear();
}

module.exports = { instanceId, _clearCache };
