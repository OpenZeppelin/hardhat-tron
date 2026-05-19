'use strict';

// Registers the `tre.compiler.*` config block via Hardhat's
// `extendConfig` hook, with full defaulting and validation.
//
// Design notes:
//
//   * No `enable` flag. Loading the plugin is consent. Opt out via
//     `tre.compiler.disabled: true` for the rare neutralisation case
//     (e.g. a downstream pipeline that wants to neutralise tron-solc
//     for one CI step).
//
//   * No parallel `compilers` array shadowing `solidity.compilers`.
//     We read directly from `solidity:` -- one source of truth for
//     the version and the settings, no duplication to keep in sync.
//
//   * `include`/`exclude` as glob arrays, not basename sets. Globs
//     are unambiguous when two files share a basename in different
//     directories.
//
//   * Activation is config-driven via `target`, not `--network`
//     gated. Tron-only projects get tron-solc unconditionally;
//     dual-target projects can scope activation to a tron-typed
//     network via `target: 'tron-when-network-tron'`.
//
// Validation runs at extendConfig time so the user sees a clear
// error at hardhat init, not partway through a compile.
//

const { TronCompileError } = require('./errors');

const DEFAULT_MIRROR = 'https://raw.githubusercontent.com/tronprotocol/solc-bin/main';

const VALID_TARGETS = new Set(['tron', 'tron-when-network-tron']);

// extendConfig is called by Hardhat with (resolved config, userConfig).
// Returns nothing -- it mutates `config.tre.compiler` in place.
function extendCompileConfig(config, userConfig) {
  const userTre = userConfig.tre || {};
  const userCompiler = userTre.compiler || {};

  // Ensure the parent `tre` block exists on the resolved config so
  // sibling modules (lifecycle, runtime) can append to the same
  // namespace. We only own `.compiler` here; we don't initialise
  // their fields.
  config.tre = config.tre || {};

  const target = userCompiler.target ?? 'tron';
  if (!VALID_TARGETS.has(target)) {
    throw new TronCompileError(
      `tre.compiler.target must be one of [${[...VALID_TARGETS].join(', ')}], got ${JSON.stringify(target)}`,
    );
  }

  const include = userCompiler.include ?? [];
  if (!Array.isArray(include) || include.some((s) => typeof s !== 'string')) {
    throw new TronCompileError(`tre.compiler.include must be an array of glob strings`);
  }

  const exclude = userCompiler.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((s) => typeof s !== 'string')) {
    throw new TronCompileError(`tre.compiler.exclude must be an array of glob strings`);
  }

  const separateArtifacts = userCompiler.separateArtifacts === true;

  const mirror = userCompiler.mirror ?? DEFAULT_MIRROR;
  if (typeof mirror !== 'string' || !/^https?:\/\//.test(mirror)) {
    throw new TronCompileError(`tre.compiler.mirror must be an http(s) URL, got ${JSON.stringify(mirror)}`);
  }

  const disabled = userCompiler.disabled === true;
  const versionPragmaOverride = userCompiler.versionPragmaOverride === true;

  // Optional batch definitions consumed by the `tron:compile-batches`
  // task. Either an inline array (`batches`) or a path to a CJS module
  // that exports the array (`batchesPath`). Type-check only here --
  // shape validation lives in the task itself where errors have more
  // context.
  const batches = userCompiler.batches;
  if (batches !== undefined && !Array.isArray(batches)) {
    throw new TronCompileError(`tre.compiler.batches must be an array if set`);
  }
  const batchesPath = userCompiler.batchesPath;
  if (batchesPath !== undefined && typeof batchesPath !== 'string') {
    throw new TronCompileError(`tre.compiler.batchesPath must be a string if set`);
  }

  // `solidity.compilers` is populated by Hardhat itself from the user's
  // `solidity:` block. If the user wrote `solidity: { version, settings }`
  // it normalises to a single-entry `compilers` array. We assert
  // single-version here -- multi-version tron-solc compiles aren't
  // supported in v0.1 (no consumer needs it yet) and silently picking
  // one would be worse than a clear error.
  if (!disabled && target === 'tron') {
    const compilers = config.solidity && config.solidity.compilers ? config.solidity.compilers : [];
    if (compilers.length === 0) {
      throw new TronCompileError(
        `tre.compiler is active (target=tron) but no solidity.compilers entries are configured`,
      );
    }
    if (compilers.length > 1) {
      throw new TronCompileError(
        `tre.compiler does not yet support multi-version compiles ` +
          `(solidity.compilers has ${compilers.length} entries: ${compilers.map((c) => c.version).join(', ')}). ` +
          `Use a single solidity.version, or open an issue.`,
      );
    }
  }

  config.tre.compiler = {
    target,
    include,
    exclude,
    separateArtifacts,
    mirror,
    disabled,
    versionPragmaOverride,
    batches,
    batchesPath,
  };
}

// Activation predicate -- used by every subtask hook to decide
// whether to runSuper() or apply the tron path.
function isActive(hre) {
  const cfg = hre.config.tre && hre.config.tre.compiler;
  if (!cfg) return false;
  if (cfg.disabled) return false;
  if (cfg.target === 'tron') return true;
  if (cfg.target === 'tron-when-network-tron') {
    return !!(hre.network && hre.network.config && hre.network.config.tron);
  }
  return false;
}

module.exports = { extendCompileConfig, isActive, DEFAULT_MIRROR };
