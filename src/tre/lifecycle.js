//
// src/tre/lifecycle.js
//
// Docker lifecycle for the TRE container that backs the auto-up task
// wrappers. Single-container case only -- multi-worker parallel test
// orchestration stays out of this package (consumers that need it
// manage their own containers and point each worker at its own
// `TRE_URL`; our auto-up gate detects "something already listening"
// and skips spawning).
//
// What this does:
//   * isReachable(url)        -- JSON-RPC tre_version probe, 2s timeout
//   * ensureUp(cfg, log)      -- docker run + wait-for-ready
//   * teardown(name)          -- docker rm -f
//   * containerExists(name)   -- short-circuit on `keepRunning` reuse
//
// Container layout mirrors docker-compose.tre.yml:
//   image:     tronbox/tre:dev (or whatever cfg.image is)
//   env:       deterministic accounts derived from the standard test
//              mnemonic, identical on every machine
//   port:      cfg.port:9090 (TVM container always exposes 9090
//              internally; we map to a host port)
//   bind:      optional cfg.jarPath -> /tron/FullNode/FullNode.jar
//   JVM tune:  G1GC + 20ms pause target. NOT cosmetic -- the
//              snapshot/revert path allocates large LinkedHashMaps
//              that, under ParallelGC, surface as multi-hundred-ms
//              STW pauses that drop the HTTP keep-alive socket and
//              fail axios mid-test. Same config as the consumer's
//              docker-compose.
//

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function defaultContainerName() {
  return `hardhat-tron-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function parsePort(networkUrl) {
  try {
    return new URL(networkUrl).port || '9090';
  } catch {
    return '9090';
  }
}

function isReachable(networkUrl, timeoutMs = 2000) {
  return new Promise(resolve => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(networkUrl.replace(/\/jsonrpc$/, '/tre'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tre_version', params: [] }),
      signal: ctrl.signal,
    })
      .then(r => r.json())
      .then(j => resolve(typeof j.result === 'string'))
      .catch(() => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

function containerExists(name) {
  const r = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^${name}$`], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === name;
}

// JVM tuning string -- required for snapshot/revert stability. See
// the header comment for why ParallelGC is unsafe under our workload.
const JAVA_TOOL_OPTIONS =
  '-XX:+UseG1GC -XX:MaxGCPauseMillis=20 -Xmx2g -Xms512m -XX:+AlwaysPreTouch -XX:+TieredCompilation';

function buildRunArgs(cfg, name) {
  const args = ['run', '-d', '--name', name, '-p', `127.0.0.1:${cfg.port}:9090`];

  const env = {
    accounts: '10',
    defaultBalance: '1000000000',
    mnemonic: 'test test test test test test test test test test test junk',
    hdPath: "m/44'/60'/0'/0",
    quiet: 'true',
    JAVA_TOOL_OPTIONS,
    ...cfg.startupEnv,
  };
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`);
  }

  // Optional patched-jar bind mount. We only attach if the file
  // actually exists -- a missing path is a user config error and
  // surfaces clearly via docker, but a stale path on a teammate's
  // machine (e.g. the jar was deleted) should NOT silently fall back
  // to the stock image. So: if jarPath is set, require it to exist.
  if (cfg.jarPath) {
    const abs = path.isAbsolute(cfg.jarPath) ? cfg.jarPath : path.resolve(process.cwd(), cfg.jarPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`tre.jarPath points at a file that does not exist: ${abs}`);
    }
    args.push('-v', `${abs}:/tron/FullNode/FullNode.jar:ro`);
  }

  args.push('--restart', 'no', cfg.image);
  return args;
}

async function waitForReady(url, deadlineMs, log) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < deadlineMs) {
    if (await isReachable(url)) {
      log(`  TRE ready in ${Math.floor((Date.now() - start) / 1000)}s`);
      return;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`TRE did not become ready at ${url} within ${deadlineMs}ms (last: ${lastErr})`);
}

// Returns { spawned, name, url }. spawned=false means we re-used an
// existing reachable container (or a manually-started one).
async function ensureUp(cfg, networkUrl, log = () => {}) {
  if (await isReachable(networkUrl)) {
    log(`  TRE already reachable at ${networkUrl} (skipping spawn)`);
    return { spawned: false, name: null, url: networkUrl };
  }

  const name = cfg.containerName || defaultContainerName();

  // If the user gave us an explicit name AND the container already
  // exists from a prior `keepRunning: true` run, restart it instead
  // of failing on the docker run.
  if (cfg.containerName && containerExists(name)) {
    log(`  starting existing container ${name}`);
    const r = spawnSync('docker', ['start', name], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`docker start ${name} failed: ${r.stderr.trim()}`);
    }
  } else {
    log(`  spawning ${cfg.image} as ${name} on port ${cfg.port}`);
    const args = buildRunArgs(cfg, name);
    const r = spawnSync('docker', args, { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error(`docker run failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  try {
    await waitForReady(networkUrl, cfg.readinessTimeoutMs, log);
  } catch (e) {
    // Surface logs from the container to help the user diagnose
    // startup failures before we kill it.
    const logs = spawnSync('docker', ['logs', '--tail', '30', name], { encoding: 'utf8' });
    e.message += `\n--- ${name} logs ---\n${logs.stdout}\n${logs.stderr}`;
    if (!cfg.keepRunning) {
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
    throw e;
  }

  return { spawned: true, name, url: networkUrl };
}

function teardown(name, log = () => {}) {
  if (!name) return;
  log(`  tearing down ${name}`);
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}

module.exports = { ensureUp, teardown, isReachable, containerExists };
