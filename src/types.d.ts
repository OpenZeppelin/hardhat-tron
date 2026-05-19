// Type declarations for @openzeppelin/hardhat-tron.
//
// JS package — this file hand-declares the config surface and the
// `hre.tre` shape so TypeScript consumers get autocompletion and
// type checking without the package itself shipping a TS toolchain.

import 'hardhat/types/config';
import 'hardhat/types/runtime';

// ---- Compile config ----------------------------------------------

export interface TreCompilerBatch {
  /** Display name used in the per-batch log line and summary table. */
  name: string;
  /** Glob array used directly as the batch's `include`. Skips dirs/extraLeaves expansion if provided. */
  include?: string[];
  /** Project-relative dirs; each expanded to `${d}/**\/*.sol`. Each `contracts/<x>` auto-pairs with `contracts/exposed/<x>`. */
  dirs?: string[];
  /** Bare basenames (no `.sol`); each expanded to `**\/<name>.sol`. Useful for top-level / scattered files. */
  extraLeaves?: string[];
}

export interface TreCompilerUserConfig {
  /** `'tron'` (default) activates unconditionally; `'tron-when-network-tron'` gates on `network.<n>.tron === true`. */
  target?: 'tron' | 'tron-when-network-tron';
  /** Glob array; empty/omitted means "compile the whole source tree" via Hardhat's default discovery. */
  include?: string[];
  /** Glob array applied after `include`. */
  exclude?: string[];
  /** If true, route artifacts/cache to `artifacts-tron/` / `cache-tron/`. Default `false`. */
  separateArtifacts?: boolean;
  /** Override the canonical `tronprotocol/solc-bin` mirror. Default `'https://raw.githubusercontent.com/tronprotocol/solc-bin/main'`. */
  mirror?: string;
  /** Emergency opt-out. Skips every subtask hook this module registers. */
  disabled?: boolean;
  /** If true, override `solidityConfig.version` in compilation jobs whose pragma range does not satisfy any configured tron-solc version. Default `false`. */
  versionPragmaOverride?: boolean;
  /** Inline batch definitions for the `tron:compile-batches` task. */
  batches?: TreCompilerBatch[];
  /** Path (absolute or project-relative) to a CJS module exporting an array of batch definitions. */
  batchesPath?: string;
}

// ---- Lifecycle config --------------------------------------------

export interface TreUserConfig {
  /** Master switch for auto-spawning a TRE container on `compile` / `test` / `node`. Default `true`. */
  autoStart?: boolean;
  /** Per-task gate — defaults to `true`. */
  autoStartOnTest?: boolean;
  /** Per-task gate — defaults to `false`. Compiling does not require a running TRE. */
  autoStartOnCompile?: boolean;
  /** Per-task gate — defaults to `true`. Running `hardhat node` without a TRE is almost always a mistake. */
  autoStartOnNode?: boolean;
  /** Docker image to spawn. Default `'tronbox/tre:dev'`. */
  image?: string;
  /** Optional patched-FullNode.jar bind mount over the image's stock jar. */
  jarPath?: string;
  /** Override the auto-generated container name. Required if you want `keepRunning` reuse across runs. */
  containerName?: string;
  /** Host port to map to the container's `9090`. Default `9090`. */
  port?: number;
  /** If `true`, skip `docker rm -f` after the task completes. Default `false`. */
  keepRunning?: boolean;
  /** Cap on the `tre_version` readiness poll. Default `60_000`. */
  readinessTimeoutMs?: number;
  /** Extra `-e KEY=value` env vars passed to `docker run`. */
  startupEnv?: Record<string, string>;
  /** Compile-specific sub-block. See {@link TreCompilerUserConfig}. */
  compiler?: TreCompilerUserConfig;
}

// ---- HRE extension -----------------------------------------------

export interface TronWeb {
  // The full TronWeb 6.x surface; opaque here to avoid pinning a
  // TronWeb version into the package's types. Consumers that need
  // full typing should import from `tronweb` directly.
  [key: string]: any;
}

export interface CheatcodeResult<T = unknown> {
  supported: boolean;
  result?: T;
  reason?: string;
}

export interface TreRuntime {
  makeTronWeb(): { tronWeb: TronWeb; address: string };
  rpcCall(tronWeb: TronWeb, method: string, params?: unknown[]): Promise<unknown>;
  mine(tronWeb: TronWeb): Promise<CheatcodeResult<unknown>>;
  setBlockTime(tronWeb: TronWeb, seconds: number): Promise<CheatcodeResult<unknown>>;
  snapshot(tronWeb: TronWeb): Promise<CheatcodeResult<string>>;
  revert(tronWeb: TronWeb, snapshotId: string): Promise<CheatcodeResult<unknown>>;
  setAccountBalance(tronWeb: TronWeb, address: string, sun: bigint | string): Promise<CheatcodeResult<unknown>>;
  setAccountCode(tronWeb: TronWeb, address: string, code: string): Promise<CheatcodeResult<unknown>>;
  setAccountStorageAt(
    tronWeb: TronWeb,
    address: string,
    slot: string,
    value: string,
  ): Promise<CheatcodeResult<unknown>>;
  unlockAccounts(tronWeb: TronWeb, addresses: string[]): Promise<CheatcodeResult<unknown>>;
  deployContract(
    tronWeb: TronWeb,
    deployerAddress: string,
    artifact: unknown,
    opts?: unknown,
  ): Promise<{ address: string; txId: string; info: unknown }>;
  prebuildDeploy(
    tronWeb: TronWeb,
    deployerAddress: string,
    artifact: unknown,
    opts?: unknown,
  ): Promise<{ signedTx: unknown; predictedAddressTron: string }>;
  submitPrebuilt(
    tronWeb: TronWeb,
    signed: unknown,
    opts?: unknown,
  ): Promise<{ address: string; txId: string; info: unknown }>;
  waitForReceipt(tronWeb: TronWeb, txId: string, opts?: { timeout?: number }): Promise<unknown>;
  loadArtifact(absPath: string): unknown;
}

// ---- Module augmentations ----------------------------------------

declare module 'hardhat/types/config' {
  interface HardhatUserConfig {
    tre?: TreUserConfig;
  }
  interface HardhatConfig {
    tre: Required<TreUserConfig> & { compiler: Required<TreCompilerUserConfig> };
  }
  interface HttpNetworkUserConfig {
    tron?: boolean;
  }
  interface HardhatNetworkUserConfig {
    tron?: boolean;
  }
  interface HttpNetworkConfig {
    tron?: boolean;
  }
  interface HardhatNetworkConfig {
    tron?: boolean;
  }
}

declare module 'hardhat/types/runtime' {
  interface HardhatRuntimeEnvironment {
    tre: TreRuntime;
  }
}
