# Changelog

All notable changes to `@openzeppelin/hardhat-tron` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-20

Initial public release. The plugin redirects Hardhat's compile + deploy pipeline at the TRON Virtual Machine via a patched `java-tron` container.

### Added

- **Compile pipeline.** `tron-solc` (the TVM-targeted `solc` fork) wired into Hardhat's compile subtasks via `extendConfig` plus four subtask hooks. SHA-256-verified downloads from the canonical `tronprotocol/solc-bin` mirror, 24h cached manifest, atomic staging with per-version Promise dedup. Glob-based `include` / `exclude` filtering on project-relative paths. Optional `artifacts-tron/` suffix mode. `tron:compile-batches` task for source trees that exceed the wasm linear-memory ceiling.
- **Runtime surface (`hre.tre.*`).** `makeTronWeb`, `rpcCall`, `mine`, `setBlockTime`, `snapshot`, `revert`, `setAccountBalance`, `setAccountCode`, `setAccountStorageAt`, `unlockAccounts`, `deployContract`, `prebuildDeploy`, `submitPrebuilt`, `waitForReceipt`, `loadArtifact`. Every cheatcode returns `{ supported, result | reason }` so callers can degrade cleanly against a stock node.
- **Signers** (`@openzeppelin/hardhat-tron/signers`). Ten deterministically-derived signers via Hardhat's well-known mnemonic at HD path `m/44'/60'/0'/0/i`, pre-funded via `tre_setAccountBalance` on first use. `refundSigners(hre)` resets balances between test files. `sendTransaction` and `predictAddress` on each signer.
- **Ethers bridge.** `hre.ethers.deployContract`, `getContractFactory`, `getContractAt`, `getSigners`, `getSigner`, and `getCreate2Address` (TVM-prefixed) route through TronWeb. A stub `hre.ethers.provider` keeps `getTransactionReceipt` resolving against the bridge's bounded LRU receipts cache. Constructor reverts surface with `.data` so `revertedWithCustomError` decodes them. Method dispatch handles impersonated writes and tuple-typed calldata via inline ABI encoding through the raw HTTP path.
- **Time module** (`@openzeppelin/hardhat-tron/time`). Instant `mine`, `mineUpTo`, `increase`, `increaseTo`, `setNextBlockTimestamp` backed by the patched FullNode's `tre_*` methods. `loadFixture` via `tre_snapshot` / `tre_revert` with reusable `SnapshotRestorer` and newer-snapshot eviction. `hardhat-network-helpers` patched at the module level to point at TVM-aware versions automatically.
- **TVM-aware chai matchers.** `changeTokenBalance(s)` parses `Transfer(address,address,uint256)` events from receipt logs; `changeEtherBalance(s)` combines the outer tx with `internal_transactions[]` so no historical-state lookup is required. Last `Assertion.addMethod` wins, so ordering vs `hardhat-chai-matchers` doesn't matter.
- **Lifecycle wrappers.** `npx hardhat test` auto-spawns a TRE container; `compile` is opt-in via `tre.autoStartOnCompile`; `node` auto-spawns and never tears down. Per-task gates, configurable image, port, container name, jar bind mount, and JVM tuning (`G1GC` with a 20 ms pause target — required for snapshot/revert stability under our workload).
- **Patched `FullNode.jar` build pipeline.** `docker/build-jar.sh` compiles the Java patches under `docker/src/` inside a temporary `tronbox/tre:dev` container, repacks the upstream jar with the patched classes overlaid (a small Python ZIP step handles nested inner classes), and stages the result at `tre/FullNode.jar`. The patched jar's `tre_version` returns `v1.0.4-oz-tron`, which the runtime probes use to detect it.
- **TypeScript declarations.** `tre.*` config types and `hre.tre.*` runtime types declared via module augmentation on `hardhat/types/config` and `hardhat/types/runtime`. Cheatcode return shape exposed as `CheatcodeResult<T>`.
- **First-party tests.** Seventeen passing unit tests on the compile pipeline, plus a three-case e2e suite that self-skips when no TRE is reachable. CI runs `Prettier` and `Mocha` jobs on `push:main` and `pull_request`.

[Unreleased]: https://github.com/OpenZeppelin/hardhat-tron/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OpenZeppelin/hardhat-tron/releases/tag/v0.1.0
