//
// plugin/compile/index.js
//
// Wires the compile module into Hardhat. Loaded once via
// `require('./compile')` from plugin/index.js. Side-effects:
//
//   * extendConfig    -> registers tre.compiler.* with defaults
//   * extendEnvironment -> opt-in artifacts-tron path suffixing
//   * subtask hooks   -> filter source paths, override compilation
//                        job version, supply the tron-solc wasm,
//                        suppress noise
//
// What this file DOES NOT do, by design:
//   - No TASK_COMPILE_SOLIDITY_READ_FILE hook. We never rewrite
//     source files. See plugin/compile/version-selector.js for why.
//   - No TASK_COMPILE_SOLIDITY_RUN_SOLC throw. Our GET_SOLC_BUILD
//     unconditionally returns isSolcJs: true, so the throw is
//     unreachable. Dead code surfaces bugs as confusing errors;
//     we'd rather see a real stack trace if invariants break.
//   - No TASK_CLEAN wrap unless separateArtifacts is enabled.
//     The standard `hardhat clean` already handles paths.artifacts/
//     paths.cache; only the suffix mode introduces a second set of
//     paths that wouldn't otherwise be cleaned.
//

const fsp = require('node:fs/promises');
const { extendConfig, extendEnvironment, subtask, task } = require('hardhat/config');
const t = require('hardhat/builtin-tasks/task-names');
const { Artifacts } = require('hardhat/internal/artifacts');

const { extendCompileConfig, isActive } = require('./config');
const { resolveSourcePaths } = require('./source-resolver');
const { selectCompilationJob } = require('./version-selector');
const downloader = require('./downloader');

// ----- 1. Config ----------------------------------------------------

extendConfig(extendCompileConfig);

// ----- 2. Environment ------------------------------------------------
//
// Only mutate artifact/cache paths if the consumer opted into the
// suffix mode. Default is to leave hre.config.paths.{artifacts,cache}
// at the stock `artifacts/`+`cache/` values so the standard IDE /
// analyzer / verifier tooling Just Works.
//

function suffixIfNeeded(p, suffix) {
  return p.endsWith(suffix) ? p : p + suffix;
}

extendEnvironment(hre => {
  // We need a tron-typed network to know which path mode applies?
  // No -- the path mode is purely a compiler-config choice, not a
  // network choice. A user with separateArtifacts=true compiling
  // against `--network hardhat` still gets `artifacts-tron/` because
  // they asked for it. Don't gate on network.
  if (!isActive(hre)) return;
  const cfg = hre.config.tre.compiler;
  if (!cfg.separateArtifacts) return;

  const newArtifacts = suffixIfNeeded(hre.config.paths.artifacts, '-tron');
  const newCache = suffixIfNeeded(hre.config.paths.cache, '-tron');
  hre.config.paths.artifacts = newArtifacts;
  hre.config.paths.cache = newCache;

  // hre.artifacts was instantiated against the OLD path before
  // extendEnvironment ran. Re-instantiate so subsequent
  // artifact reads/writes hit the suffixed location.
  hre.artifacts = new Artifacts(newArtifacts);
});

// ----- 3. Subtask hooks ---------------------------------------------

subtask(t.TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, resolveSourcePaths);

subtask(t.TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE, selectCompilationJob);

subtask(t.TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, hre, runSuper) => {
  if (!isActive(hre)) return runSuper();
  const cfg = hre.config.tre.compiler;
  const { compilerPath, version, longVersion } = await downloader.getCompiler(solcVersion, { mirror: cfg.mirror });
  return {
    compilerPath,
    isSolcJs: true,
    version,
    longVersion,
  };
});

// Suppress the "Downloading compiler ..." preamble Hardhat prints --
// our downloader does its own logging (or stays silent on a cache
// hit, which is the common case).
subtask(t.TASK_COMPILE_SOLIDITY_LOG_DOWNLOAD_COMPILER_START, async (args, hre, runSuper) => {
  if (!isActive(hre)) return runSuper();
});

// ----- 4. Clean wrap (suffix mode only) -----------------------------
//
// Only when separateArtifacts is true do we need to wipe a second
// set of paths. We compute them up front because by the time TASK_CLEAN
// runs, hre.config.paths.artifacts has already been mutated to the
// suffixed value -- so to clean BOTH the suffixed and non-suffixed
// paths (e.g. when toggling separateArtifacts off-then-on, or when
// recovering from a partial migration) we strip then re-add.
//

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

async function emptyDir(p) {
  await rmrf(p);
  await fsp.mkdir(p, { recursive: true });
}

task(t.TASK_CLEAN, async ({ global }, hre, runSuper) => {
  if (!isActive(hre) || !hre.config.tre.compiler.separateArtifacts) {
    return runSuper({ global });
  }
  // Suffix-mode paths (current).
  const a = hre.config.paths.artifacts;
  const c = hre.config.paths.cache;
  // Stripped paths -- catches stale `artifacts/` left over from a
  // prior non-suffix run, or from a sibling stock-solc compile.
  const aStripped = a.endsWith('-tron') ? a.slice(0, -5) : null;
  const cStripped = c.endsWith('-tron') ? c.slice(0, -5) : null;

  await rmrf(a);
  await emptyDir(c);
  if (aStripped && aStripped !== a) await rmrf(aStripped);
  if (cStripped && cStripped !== c) await emptyDir(cStripped);
  return runSuper({ global });
});

// ----- exports (none) -----------------------------------------------
//
// This module is loaded for its side-effects; importers should `require`
// it for the hooks. No public surface is exposed yet -- the downloader
// and manifest helpers stay internal until a real consumer needs them.
