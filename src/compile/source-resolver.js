'use strict';

// Hooks `TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS` to support glob-based
// include/exclude filtering.
//
//   * Globs, not basenames. `contracts/foo/Test.sol` and
//     `contracts/bar/Test.sol` are addressable independently --
//     basename-only filtering would silently conflate them.
//
//   * Both include AND exclude supported. Empty arrays = no
//     restriction; matches Hardhat's default discovery.
//
//   * We re-read `hre.config.tre.compiler.include` on every
//     invocation. The batched-compile task swaps the array between
//     passes; the array reference itself may change, so we don't
//     cache anything across calls.
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

  return getAllFilesMatching(sources, (abs) => {
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
