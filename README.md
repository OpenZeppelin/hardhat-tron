# @openzeppelin/hardhat-tron

Hardhat plugin for compiling and deploying Solidity contracts onto the TRON TVM via a local `java-tron` (TRE) container.

Features:

- **One source of truth for compiler config.** Reads `solidity.compilers` directly — no parallel compiler array to keep in sync.
- **SHA-256 verified wasm downloads.** Fetches tron-solc from the canonical `tronprotocol/solc-bin` mirror and verifies each blob against the upstream `list.json` manifest.
- **Glob include/exclude.** Two `Test.sol` files in different directories are individually addressable; basename-only filtering would silently conflate them.
- **No source-file rewriting.** The compiler sees exactly what's on disk; no pragma regex hacks. Source maps, stack traces, and IDE jumps stay accurate.
- **Stock artifact paths by default.** `artifacts/` and `cache/` — opt into an `artifacts-tron/` suffix only when you actually need a dual EVM+Tron build coexisting in one project.
- **No `hardhat-deploy` dependency.** Compile and runtime helpers are independent of the deployments toolchain.
- **Auto-spawn the TRE container.** `npx hardhat test` brings the container up, runs, tears it down. Override with `tre.autoStart: false` if you manage containers yourself.

## Install

```bash
npm install @openzeppelin/hardhat-tron
```

Peer deps: `hardhat ^2.26`, `@nomicfoundation/hardhat-ethers ^3`, `@nomicfoundation/hardhat-chai-matchers ^2`, `ethers ^6.14`.

## Usage

```js
// hardhat.config.cjs
require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
require('@openzeppelin/hardhat-tron');

module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: true,
      // Embed source code as literal text inside each contract's
      // metadata JSON so verification services (Sourcify, Etherscan,
      // ...) can reconstruct it. Without this flag the metadata IPFS
      // hash baked into bytecode shifts; set it explicitly for
      // reproducibility.
      metadata: { bytecodeHash: 'ipfs', useLiteralContent: true },
    },
  },
  tre: {
    autoStart: true,
    image: 'tronbox/tre:dev',
    // Optional: bind-mount a patched FullNode.jar for time-warp +
    // snapshot/revert. Without it, those degrade to real-time waits.
    // jarPath: './path/to/FullNode.jar',
    compiler: {
      target: 'tron',
      // include: ['contracts/**/*.sol'],   // optional; defaults to all sources
      // exclude: ['contracts/vendor/**'],
    },
  },
  defaultNetwork: 'tre',
  networks: {
    tre: {
      url: process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc',
      tron: true,
      accounts: [process.env.TRE_PRIVATE_KEY || '0xdd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5'],
    },
  },
};
```

Then:

```bash
npx hardhat compile     # tron-solc, SHA-256 verified, output to artifacts/
npx hardhat test        # auto-spawns tronbox/tre:dev, runs tests, tears down
```

## Configuration reference

### `tre`

| Key | Default | Notes |
|---|---|---|
| `autoStart` | `true` | Master switch for the docker-spawn behaviour. |
| `autoStartOnTest` | `true` | Per-task gate. |
| `autoStartOnCompile` | `false` | Compile doesn't need a running TRE. |
| `autoStartOnNode` | `true` | `hardhat node` against a tron network expects TRE. |
| `image` | `'tronbox/tre:dev'` | Docker image. |
| `jarPath` | `null` | Optional `:/tron/FullNode/FullNode.jar:ro` bind mount. |
| `containerName` | auto-generated | Set to a fixed name to enable `keepRunning` reuse. |
| `port` | `9090` | Host port mapped to the container's 9090. |
| `keepRunning` | `false` | Skip `docker rm -f` on task exit. |
| `readinessTimeoutMs` | `60_000` | Cap on the JSON-RPC `tre_version` poll. |
| `startupEnv` | `{}` | Extra `-e KEY=value` for `docker run`. |

### `tre.compiler`

| Key | Default | Notes |
|---|---|---|
| `target` | `'tron'` | `'tron'` always activates; `'tron-when-network-tron'` gates on `network.<n>.tron`. |
| `include` | `[]` | Glob array. Empty = use Hardhat's default source discovery. |
| `exclude` | `[]` | Glob array applied after `include`. |
| `separateArtifacts` | `false` | If true, route to `artifacts-tron/` + `cache-tron/`. |
| `mirror` | `tronprotocol/solc-bin` | URL prefix for `wasm/list.json` and the wasm blobs. |
| `disabled` | `false` | Emergency opt-out (skips every subtask hook). |
| `versionPragmaOverride` | `false` | Override `solidityConfig.version` when a contract's pragma doesn't satisfy the configured tron-solc version. |
| `batches` | `undefined` | Inline batch defs for the `tron:compile-batches` task. |
| `batchesPath` | `undefined` | Path to a CJS module exporting the array. |

## `hre.tre.*` runtime helpers

When loaded, the plugin extends the Hardhat runtime with `hre.tre`:

```js
// Drop into a test:
const { tronWeb, address } = hre.tre.makeTronWeb();
const counter = await hre.tre.deployContract('Counter');
await hre.tre.mine(tronWeb);                           // tre_mine cheatcode
await hre.tre.setBlockTime(tronWeb, 0);                // instamine
await hre.tre.setAccountBalance(tronWeb, addr, 10n ** 18n);
```

It also overrides `hre.ethers.{deployContract, getContractFactory, getSigners, getContractAt, provider}` so unmodified ethers-based tests can run against TRE without rewriting fixtures.

## Batched compile

The 0.8.26 tron-solc wasm has a memory ceiling that large source trees (e.g. the OpenZeppelin v5 corpus, ~700 files) exceed in a single pass. The `tron:compile-batches` task splits compilation into passes that each stay under the limit. Single-process, shared cache across passes.

```js
// hardhat.config.cjs
tre: {
  compiler: {
    batches: [
      { name: '01-utils', dirs: ['contracts/utils'] },
      { name: '02-token', dirs: ['contracts/token/ERC20'] },
      // ...
    ],
  },
},
```

Then `npx hardhat tron:compile-batches`.

Each batch entry:

- `name` (required) — log label
- `dirs` — project-relative dirs; auto-expanded to `${d}/**/*.sol`, with each `contracts/<x>` auto-pairing with `contracts/exposed/<x>` for `hardhat-exposed` users
- `extraLeaves` — basenames (no `.sol`); expanded to `**/<name>.sol`
- `include` — raw globs that override `dirs`/`extraLeaves` expansion

## Docker / FullNode.jar

The `docker/` directory contains Java patches that enable time-warp (`time.increase`, `setNextBlockTimestamp`) and snapshot/revert semantics. Build the patched jar locally:

```bash
bash node_modules/@openzeppelin/hardhat-tron/docker/build-jar.sh
```

This produces a ~200 MB `FullNode.jar`. Stage it somewhere stable in your project and reference it via `tre.jarPath`. Without the patch, the stock `tronbox/tre:dev` image's jar is used and time-warps degrade to real-time waits.

## License

MIT — see `LICENSE`.
