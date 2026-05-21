# @openzeppelin/hardhat-tron

A Hardhat plugin that lets you write, compile, and test Solidity contracts for the **TRON network** the same way you would for any EVM chain — using familiar tools like `ethers`, `chai`, and `npx hardhat test`.

Under the hood it compiles your contracts with the TRON-flavored Solidity compiler (`tron-solc`) and runs them against a local TRON node (`java-tron`, aka **TRE**) that the plugin spins up for you inside Docker.

## What you get

- **Write tests like you always do.** `hre.ethers.deployContract(...)`, chai matchers, signers — all wired up to TRON.
- **Zero-config local node.** `npx hardhat test` starts a TRE container, runs your tests, and tears it down. No manual `docker run`.
- **One compiler config.** Reuses your existing `solidity.compilers` block — nothing parallel to keep in sync.
- **Safe binary downloads.** Fetches `tron-solc` wasm from the official `tronprotocol/solc-bin` mirror and verifies each blob against the upstream SHA-256 manifest.
- **No source rewriting.** Your `.sol` files reach the compiler exactly as written — pragmas, source maps, IDE jumps, and stack traces all stay correct.
- **Standard artifact paths.** Outputs to `artifacts/` and `cache/` by default. Opt into a `-tron` suffix only if you need a dual EVM + TRON build in one project.

## Prerequisites

Before you install, make sure you have:

1. **Node.js 20 or newer** — `node --version`
2. **Docker Desktop running** — the plugin spawns a TRON node in a container
3. **A Hardhat project** — if you don't have one yet, run `npx hardhat init` in an empty folder

## Step 1 — Install

From inside your Hardhat project:

```bash
npm install --save-dev @openzeppelin/hardhat-tron \
  hardhat \
  @nomicfoundation/hardhat-ethers \
  @nomicfoundation/hardhat-chai-matchers \
  ethers
```

The peer deps (`hardhat ^2.26`, `@nomicfoundation/hardhat-ethers ^3`, `@nomicfoundation/hardhat-chai-matchers ^2`, `ethers ^6.14`) are required — install them if you don't have them already.

## Step 2 — Configure Hardhat

Open (or create) `hardhat.config.cjs` and replace its contents with:

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
      // Embed source as literal text in metadata so verification
      // services (Sourcify, etc.) can reconstruct it deterministically.
      metadata: { bytecodeHash: 'ipfs', useLiteralContent: true },
    },
  },
  tre: {
    autoStart: true,
    image: 'tronbox/tre:dev',
    compiler: { target: 'tron' },
  },
  defaultNetwork: 'tre',
  networks: {
    tre: {
      url: process.env.TRE_URL || 'http://127.0.0.1:9090/jsonrpc',
      tron: true,
      accounts: [
        process.env.TRE_PRIVATE_KEY ||
          '0xdd23ca549a97cb330b011aebb674730df8b14acaee42d211ab45692699ab8ba5',
      ],
    },
  },
};
```

> The default private key shown above is a well-known TRE dev key — fine for local tests, **never** use it on a real network.

## Step 3 — Compile your contracts

```bash
npx hardhat compile
```

The first run downloads `tron-solc` (a few MB), verifies its SHA-256, and writes artifacts to `artifacts/`. Subsequent runs use the cache.

## Step 4 — Run your tests

```bash
npx hardhat test
```

The plugin will:

1. Pull `tronbox/tre:dev` if you don't have it (one-time, a few hundred MB)
2. Start a TRE container in the background
3. Wait until the node is ready
4. Run your Mocha tests against it
5. Stop and remove the container when tests finish

That's it. You're testing Solidity on TRON.

## Writing a test

Your existing ethers-based tests work as-is. Here's a minimal example:

```js
// test/Counter.test.js
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('Counter', () => {
  it('increments', async () => {
    const counter = await ethers.deployContract('Counter');
    await counter.increment();
    expect(await counter.value()).to.equal(1n);
  });
});
```

For TRON-specific things (time-warp, balance manipulation, raw TronWeb access) the plugin exposes `hre.tre`:

```js
const { tronWeb, address } = hre.tre.makeTronWeb();
const counter = await hre.tre.deployContract('Counter');
await hre.tre.mine(tronWeb);                              // tre_mine cheatcode
await hre.tre.setBlockTime(tronWeb, 0);                   // instamine
await hre.tre.setAccountBalance(tronWeb, addr, 10n ** 18n);
```

`hre.ethers.{deployContract, getContractFactory, getSigners, getContractAt, provider}` are transparently overridden, so unmodified ethers tests run against TRE without any fixture changes.

## Troubleshooting

**"Cannot connect to the Docker daemon"** — Docker isn't running. Start Docker Desktop and try again.

**Tests hang on startup** — first-time image pull can take a minute or two. Run `docker pull tronbox/tre:dev` manually to see progress.

**Port 9090 already in use** — set `tre.port` to a free port in your config (and update the network `url` to match).

**Want to manage the container yourself?** Set `tre.autoStart: false` and start TRE manually with `docker run --rm -p 9090:9090 tronbox/tre:dev`.

---

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

## Advanced: batched compile

The 0.8.26 `tron-solc` wasm has a memory ceiling that very large source trees (e.g. the OpenZeppelin v5 corpus, ~700 files) exceed in a single pass. The `tron:compile-batches` task splits compilation into multiple passes that each stay under the limit. Single-process, shared cache across passes.

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

Then run `npx hardhat tron:compile-batches`.

Each batch entry:

- `name` (required) — log label
- `dirs` — project-relative dirs; auto-expanded to `${d}/**/*.sol`, with each `contracts/<x>` auto-pairing with `contracts/exposed/<x>` for `hardhat-exposed` users
- `extraLeaves` — basenames (no `.sol`); expanded to `**/<name>.sol`
- `include` — raw globs that override `dirs`/`extraLeaves` expansion

## Advanced: patched FullNode.jar (time-warp + snapshot/revert)

The `docker/` directory contains Java patches that enable `time.increase`, `setNextBlockTimestamp`, and snapshot/revert semantics on TRE. Without the patch, those operations degrade to real-time waits (i.e. actually sleeping for the requested duration).

To build the patched jar locally:

```bash
bash node_modules/@openzeppelin/hardhat-tron/docker/build-jar.sh
```

This produces a ~200 MB `FullNode.jar`. Stage it somewhere stable in your project and point at it from your config:

```js
tre: {
  jarPath: './path/to/FullNode.jar',
},
```

## License

MIT — see [LICENSE](LICENSE).
