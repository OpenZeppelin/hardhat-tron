//
// plugin/compile/version-selector.js
//
// Hooks `TASK_COMPILE_SOLIDITY_GET_COMPILATION_JOB_FOR_FILE`. Two
// design choices that differ from LZ:
//
//   1. We do NOT mutate source files. LZ's plugin had a separate
//      `READ_FILE` hook that regex-rewrote pragma lines to satisfy
//      version constraints. That makes the source the compiler sees
//      differ from the source on disk -- source maps, stack traces,
//      and IDE jumps all go subtly wrong. We refuse to do that.
//
//   2. Version override is opt-in via `versionPragmaOverride: true`.
//      Without it, contracts whose pragma doesn't satisfy our
//      configured solidity.version surface as a normal Hardhat
//      "no compatible compiler" error. With it, we force-override
//      the compilation job's version to ours -- but the source on
//      disk is left alone. The override is a footgun knob, not the
//      default.
//
// Either way: we don't touch `solidityConfig.settings`. The user
// configured those in `solidity.settings` and they apply unchanged.
// LZ shallow-merged `optimizer` and `metadata` from a separate
// `tronSolc.compilers[].settings` block, which encouraged the dual-
// source-of-truth that's now gone.
//

const { isActive } = require('./config');

async function selectCompilationJob({ dependencyGraph, file }, hre, runSuper) {
  // eslint-disable-next-line no-unused-vars
  const _ = dependencyGraph; // kept in destructure for Hardhat signature parity
  const job = await runSuper();
  if (!isActive(hre)) return job;
  if ('reason' in job) return job; // upstream error; leave it alone

  const cfg = hre.config.tre.compiler;
  if (!cfg.versionPragmaOverride) return job;

  // Single-version mode (asserted in config.js): take the lone
  // entry from solidity.compilers and overwrite the job's
  // solidityConfig.version. Settings are left as Hardhat built them
  // -- they reflect the user's solidity.settings exactly.
  const compilers = hre.config.solidity.compilers;
  const target = compilers[0];
  if (job.solidityConfig.version !== target.version) {
    job.solidityConfig.version = target.version;
  }
  return job;
}

module.exports = { selectCompilationJob };
