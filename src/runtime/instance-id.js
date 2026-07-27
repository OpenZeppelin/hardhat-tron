'use strict';

// A stable identifier for a specific TRE node instance, resolved in four
// tiers, each tried only if the one before it does not apply:
//
//   0. Node-served: a patched TRE answers `tre_instanceId` directly over RPC
//      (nodeServedInstanceId) — a random id generated once per node process.
//      Any observer, including one docker-blind to the container, resolves
//      the same value, so this short-circuits tiers 1-2 entirely. Deliberately
//      probed for ANY url, not just local ones, so a remote self-hosted
//      patched TRE still answers; a network that does not answer this costs
//      at most the 2s timeout, and only once per process since the result is
//      cached thereafter.
//   1. Owned: this plugin launched the container (lifecycle.launchedContainerFor).
//      Its identity is read via `docker inspect` and MUST succeed — a failure
//      here throws rather than falling through to a weaker tier, since we know
//      a container exists and silently substituting a different id would be
//      wrong, not merely imprecise.
//   2. Discovered: some other local process launched the container, but it is
//      still identifiable by the docker daemon from the url's host port
//      (lifecycle.containerServing). Same hash formula as tier 1
//      (hashContainerIdentity), so an owned and a foreign observer of the same
//      container agree on its id.
//   3. Genesis fallback: no docker container could be attributed to the url
//      (remote daemon, non-loopback host, or docker unavailable). The genesis
//      (block 0) hash is a constant shared by every TRE booted from the same
//      image and startup env, so it cannot distinguish two such TREs, or two
//      deterministic restarts of the same one. Consumers that need a
//      guaranteed-fresh id per restart should let this plugin manage the
//      container lifecycle (tier 1) or run it where tier 2 can see it.
//
// Container identity (tiers 1-2) is per-boot fresh because docker assigns a
// new container id on every fresh `docker run`, and `StartedAt` also changes
// on every `docker start` — so together they distinguish restarts even of a
// reused container.
//
// The id is immutable for the life of a node, so it is resolved once and cached
// per url. `networkName` is accepted for the caller's convenience but does not
// participate in the key: id derivation depends only on the url, and two
// networks sharing a url point at the same node and must share an id.

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const lifecycle = require('../tre/lifecycle');

const _instanceIdCache = new Map();

// Shared hashing site for both container-derived tiers (owned and discovered),
// so they cannot drift and produce different ids for the same container.
function hashContainerIdentity(id, startedAt) {
  return '0x' + crypto.createHash('sha256').update(`${id}|${startedAt}`).digest('hex');
}

// Shared field validation for both container-derived tiers: rejects an empty
// id, an empty startedAt, or either containing docker's own "<no value>"
// placeholder (an unset Go template field), before it ever reaches the hash.
function validatedContainerIdentity(id, startedAt) {
  if (!id || !startedAt || id.includes('<no value>') || startedAt.includes('<no value>')) return undefined;
  return hashContainerIdentity(id, startedAt);
}

// docker container id + StartedAt, hashed. Returns undefined if docker is
// unavailable, the container is unknown, or the fields could not be read.
function containerInstanceId(containerName) {
  const r = spawnSync('docker', ['inspect', '--format', '{{.Id}}|{{.State.StartedAt}}', containerName], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return undefined;
  const raw = (r.stdout || '').trim();
  const s = raw.indexOf('|');
  if (s === -1) return undefined;
  return validatedContainerIdentity(raw.slice(0, s), raw.slice(s + 1));
}

// Tier 0: a patched TRE answers tre_instanceId with a random per-boot id any
// observer can read. Undefined on stock images or unreachable nodes.
async function nodeServedInstanceId(url) {
  try {
    const res = await fetch(url.replace(/\/jsonrpc$/, '/tre'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tre_instanceId', params: [] }),
      signal: AbortSignal.timeout(2000),
    }).then((r) => r.json());
    const id = res && res.result;
    return typeof id === 'string' && /^0x[0-9a-f]{64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

// Genesis block hash over plain JSON-RPC. java-tron reports the Tron block ID
// as the block's `hash` (0x-prefixed), so this matches the id TronWeb's
// `trx.getBlock(0).blockID` would yield — without needing a TronWeb client,
// whose construction requires a private key the read itself does not.
async function genesisInstanceId(provider, url) {
  const genesis = await provider.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] });
  const hash = genesis && genesis.hash;
  if (!hash) {
    throw new Error(`Could not read the genesis block hash from ${url} to derive a TRE instance id.`);
  }
  return hash;
}

async function instanceId({ networkName, url, provider }) {
  const cached = _instanceIdCache.get(url);
  if (cached) return cached;

  let id = await nodeServedInstanceId(url);
  if (!id) {
    const ownedName = lifecycle.launchedContainerFor(url);
    if (ownedName) {
      // We launched this container, so its identity is readable by contract;
      // falling back would substitute an id that repeats across restarts.
      id = containerInstanceId(ownedName);
      if (!id) {
        throw new Error(
          `hardhat-tron launched the TRE container "${ownedName}" for ${url} ` +
            `but could not read its docker identity (docker inspect failed). ` +
            `Check that docker is still reachable, or remove the container and rerun.`,
        );
      }
    } else {
      const found = lifecycle.containerServing(url);
      if (found) id = validatedContainerIdentity(found.id, found.startedAt);
    }
    if (!id) {
      // Last resort: the genesis hash is constant across deterministic boots
      // of the same image + env, so it cannot distinguish restarts.
      id = await genesisInstanceId(provider, url);
    }
  }

  _instanceIdCache.set(url, id);
  return id;
}

// Called by the TRE lifecycle when it removes the container serving a url,
// so a later boot on the same url resolves a fresh identity.
function evictInstanceId(url) {
  _instanceIdCache.delete(url);
}

module.exports = { instanceId, evictInstanceId };
