'use strict';

// `tron:compile-batches` task. Compiles a project through tron-solc
// in multiple passes instead of one, so each pass stays under the
// wasm memory ceiling that the 0.8.26 tron-solc build hits on large
// source trees (empirically somewhere between 91 and 226 files for a
// full OpenZeppelin Contracts v5 corpus). Artifacts accumulate
// across passes; the compile cache is preserved so shared imports
// compile only once.
//
// In-process model (one node, many `hre.run('compile')` calls):
//   * no 5-10s per-batch hardhat init cost
//   * single shared compile cache
//   * simpler error reporting (one stack trace, no IPC)
//
// Our source-resolver subtask reads `hre.config.tre.compiler.include`
// on every invocation, so mutating that array between passes
// propagates to subsequent compiles.
//
// Batch definitions come from the CONSUMER'S config, not from this
// package. Two shapes accepted:
//
//   hre.config.tre.compiler.batches = [
//     { name: '01-utils', dirs: ['contracts/utils'] },
//     { name: '02-token', dirs: ['contracts/token'], extraLeaves: ['ERC20'] },
//     ...
//   ]
//
//   hre.config.tre.compiler.batchesPath = './batches.config.cjs'
//     // resolved relative to the project root; module.exports must be
//     // the array above.
//
// Each batch entry supports:
//   name:        string (required) -- shown in the log/table
//   include:     string[] (optional) -- raw globs, used as-is
//   dirs:        string[] (optional) -- expanded to `${d}/**/*.sol`
//                with automatic pairing of `contracts/exposed/<x>` for
//                each `contracts/<x>` (matches hardhat-exposed layout)
//   extraLeaves: string[] (optional) -- bare basenames, expanded to
//                `**/<name>.sol`
//
// Specifying `include` skips dirs/extraLeaves expansion. Specifying
// none of them makes the batch a no-op (compiles nothing).
//

const path = require('node:path');
const fs = require('node:fs');
const { task } = require('hardhat/config');

function loadBatches(hre) {
  const cfg = hre.config.tre && hre.config.tre.compiler;
  if (cfg && Array.isArray(cfg.batches) && cfg.batches.length) {
    return cfg.batches;
  }
  if (cfg && typeof cfg.batchesPath === 'string') {
    const abs = path.isAbsolute(cfg.batchesPath)
      ? cfg.batchesPath
      : path.resolve(hre.config.paths.root, cfg.batchesPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`tre.compiler.batchesPath does not exist: ${abs}`);
    }
    delete require.cache[abs];
    const mod = require(abs);
    if (!Array.isArray(mod)) {
      throw new Error(`tre.compiler.batchesPath module must export an array of batch objects: ${abs}`);
    }
    return mod;
  }
  throw new Error(
    `tron:compile-batches requires either tre.compiler.batches (array) ` +
      `or tre.compiler.batchesPath (string) in hardhat.config`,
  );
}

// Walk a tree and count contract artifacts (.json, excluding the
// .dbg.json debug companions). Used for the post-batch summary.
function countArtifacts(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.json') && !f.endsWith('.dbg.json')).length;
}

// Convert a batch definition (dirs + extraLeaves) into the glob
// array consumed by `tre.compiler.include`. Auto-pairs each
// `contracts/<x>` with `contracts-exposed/<x>` so the wrappers
// compile in the same pass as their originals — the
// `hardhat-exposed` plugin's layout convention (a top-level
// `contracts-exposed/` tree, never under `contracts/`; the source
// resolver scans it as an extra root). Expressed declaratively here.
function batchGlobs(batch) {
  if (Array.isArray(batch.include) && batch.include.length) {
    return batch.include;
  }
  const out = [];
  for (const d of batch.dirs || []) {
    out.push(`${d}/**/*.sol`);
    if (d.startsWith('contracts/') && !d.startsWith('contracts-exposed')) {
      out.push(`${d.replace(/^contracts\//, 'contracts-exposed/')}/**/*.sol`);
    }
  }
  for (const leaf of batch.extraLeaves || []) {
    out.push(`**/${leaf}.sol`);
  }
  return out;
}

task('tron:compile-batches', 'Compile through tron-solc in batches to dodge wasm memory ceilings').setAction(
  async (_, hre) => {
    if (!hre.config.tre || !hre.config.tre.compiler) {
      throw new Error('tron:compile-batches requires `tre.compiler.*` configuration');
    }

    const batches = loadBatches(hre);
    const artifactsDir = hre.config.paths.artifacts;
    const cacheDir = hre.config.paths.cache;

    // One clean wipe at the start so the run is reproducible.
    // Subsequent batches keep cache + artifacts so shared imports
    // compile only once.
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const summary = [];
    let cumulativeMs = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const include = batchGlobs(batch);

      const label = `[${i + 1}/${batches.length}] ${batch.name}`;
      console.log(`\n${label} — ${include.length} glob(s)`);

      // Mutate the live config in place. The source-resolver reads
      // `hre.config.tre.compiler.include` on every invocation, so the
      // next compile picks up the new allowlist.
      hre.config.tre.compiler.include = include;

      const before = countArtifacts(artifactsDir);
      const start = Date.now();
      await hre.run('compile', { quiet: true });
      const ms = Date.now() - start;
      cumulativeMs += ms;
      const after = countArtifacts(artifactsDir);

      summary.push({
        name: batch.name,
        globs: include.length,
        added: after - before,
        cumulative: after,
        ms,
      });

      console.log(`  ✓ ${after - before} new artifacts (${after} cumulative) in ${ms} ms`);
    }

    console.log('\nDone.');
    console.log(`Total compile time: ${cumulativeMs} ms`);
    console.log(`Final artifact count: ${countArtifacts(artifactsDir)}`);
    console.table(
      summary.map((s) => ({
        batch: s.name,
        globs: s.globs,
        added: s.added,
        cumulative: s.cumulative,
        ms: s.ms,
      })),
    );
  },
);
