//
// plugin/compile/source-resolver.js
//
// Hooks `TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS` to support glob-based
// include/exclude filtering. Different from LZ in three ways:
//
//   1. Globs, not basenames. `contracts/foo/Test.sol` and
//      `contracts/bar/Test.sol` can be addressed independently.
//
//   2. Both include AND exclude. LZ only supported a positive
//      basename allowlist.
//
//   3. Empty include = compile everything (runSuper). LZ treated
//      empty filter the same way but via a `.size === 0` check on a
//      Set; ours is the same semantics expressed via array length.
//      Matters because the batched-compile task swaps `include`
//      arrays in place -- the array reference may change between
//      compiles, so we re-read every invocation.
//

const path = require('node:path');
const micromatch = require('micromatch');
const { getAllFilesMatching } = require('hardhat/internal/util/fs-utils');

const { isActive } = require('./config');

async function resolveSourcePaths({ sourcePath }, hre, runSuper) {
  if (!isActive(hre)) return runSuper();

  const cfg = hre.config.tre.compiler;
  const hasInclude = cfg.include.length > 0;
  const hasExclude = cfg.exclude.length > 0;
  if (!hasInclude && !hasExclude) return runSuper();

  const root = hre.config.paths.root;
  const sources = sourcePath ?? hre.config.paths.sources;

  return getAllFilesMatching(sources, abs => {
    if (!abs.endsWith('.sol')) return false;
    // Match globs against the project-relative path, not the
    // absolute one -- consumers write `contracts/**/*.sol`, not
    // `/Users/.../contracts/**/*.sol`.
    const rel = path.relative(root, abs);
    if (hasInclude && !micromatch.isMatch(rel, cfg.include)) return false;
    if (hasExclude && micromatch.isMatch(rel, cfg.exclude)) return false;
    return true;
  });
}

module.exports = { resolveSourcePaths };
