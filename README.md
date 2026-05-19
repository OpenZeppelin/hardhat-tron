# @openzeppelin/hardhat-tron

Hardhat plugin for compiling and deploying Solidity contracts to the TRON Virtual Machine.

> **Status: work in progress.** The public API is unstable until the `0.1.0` release.

## Compile

Loading the plugin redirects Hardhat's Solidity compile pipeline at `tron-solc` — a TVM-targeted fork of `solc` published on `tronprotocol/solc-bin`. No code changes are required in the consumer; just add the plugin to `hardhat.config.cjs`:

```js
require('@openzeppelin/hardhat-tron');

module.exports = {
  solidity: {
    version: '0.8.26',
    settings: {
      /* … */
    },
  },
  tre: {
    compiler: {
      // 'tron' (default): always compile with tron-solc.
      // 'tron-when-network-tron': only on tron-typed networks.
      target: 'tron',
      // Optional glob filters. Empty arrays = no restriction.
      include: ['contracts/**/*.sol'],
      exclude: ['contracts/mocks/**'],
      // Route artifacts to artifacts-tron/ instead of artifacts/.
      separateArtifacts: false,
    },
  },
};
```

The compiler wasm is fetched on demand from the canonical mirror (`https://raw.githubusercontent.com/tronprotocol/solc-bin/main`), SHA-256-verified against the manifest, and cached under Hardhat's standard `compilers-v2/` directory. Override the mirror via `tre.compiler.mirror`.

### Batched compiles

`tron-solc@0.8.26` hits a wasm linear-memory ceiling on large source trees (empirically between ~90 and ~230 files, depending on optimizer settings and constructor complexity). For projects above that ceiling, the plugin exposes a `tron:compile-batches` task that compiles in passes, accumulating artifacts and reusing the compile cache so shared imports compile only once:

```bash
npx hardhat tron:compile-batches
```

Each batch is declared either inline or via a separate file:

```js
tre: {
  compiler: {
    batches: [
      { name: '01-utils',  dirs: ['contracts/utils'] },
      { name: '02-access', dirs: ['contracts/access'] },
      { name: '03-token',  dirs: ['contracts/token'], extraLeaves: ['SafeERC20'] },
    ],
    // Or, equivalently:
    batchesPath: './tron-batches.config.cjs',
  },
}
```

Each batch entry supports:

| Field         | Type                  | Effect                                                                                                                               |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | `string` (required)   | Display label and progress key                                                                                                       |
| `include`     | `string[]` (optional) | Raw globs, used as-is — skips the dirs/extraLeaves expansion                                                                         |
| `dirs`        | `string[]` (optional) | Expanded to `${dir}/**/*.sol`. Each `contracts/<x>` automatically pairs with `contracts/exposed/<x>` for `hardhat-exposed` consumers |
| `extraLeaves` | `string[]` (optional) | Bare basenames, expanded to `**/<name>.sol` for scattered top-level files                                                            |

The task wipes `paths.artifacts` and `paths.cache` once at the start so the run is reproducible, then mutates `tre.compiler.include` between passes — the source-resolver subtask re-reads this on every invocation, so each compile sees only the current batch's source set.

## Auto-up: TRE lifecycle on `hardhat test`

When a Hardhat network is declared `tron: true` and `tre.autoStart` is left at its default (`true`), `npx hardhat test` spawns a TRE container before tests run and tears it down on exit:

```js
module.exports = {
  networks: {
    tre: {
      url: 'http://127.0.0.1:9090/jsonrpc',
      tron: true,
      accounts: [process.env.TRE_PRIVATE_KEY],
    },
  },
  tre: {
    image: 'tronbox/tre:dev', // default
    port: 9090, // default; host side, container exposes 9090
    jarPath: './tre/FullNode.jar', // optional patched-jar bind mount
    autoStart: true, // default — master switch
    autoStartOnTest: true, // default — per-task gate
    keepRunning: false, // default — set true to skip teardown
    readinessTimeoutMs: 60_000, // default — wait-for-ready budget
  },
};
```

The lifecycle wrapper skips spawning when:

- `tre.autoStart` is `false`,
- the per-task gate is `false` (`autoStartOnTest` / `autoStartOnCompile` / `autoStartOnNode`),
- the selected network does not have `tron: true`, or
- something is already responding on the network's URL (manual `docker-compose up -d`, a teammate's existing container, or a previous run left up by `keepRunning`).

Teardown is skipped if `keepRunning` is `true` OR if a pre-existing container was reused — the plugin never tears down a container it didn't spawn.

### Per-task gates

The three Hardhat tasks the plugin can auto-spawn for behave slightly differently:

| Task              | Gate                 | Default | Teardown                                           |
| ----------------- | -------------------- | ------- | -------------------------------------------------- |
| `hardhat test`    | `autoStartOnTest`    | `true`  | Yes (unless `keepRunning`)                         |
| `hardhat compile` | `autoStartOnCompile` | `false` | Yes (unless `keepRunning`)                         |
| `hardhat node`    | `autoStartOnNode`    | `true`  | **No** — `node` is long-running; user owns cleanup |

`hardhat compile` is opt-in because `tron-solc` compiles wasm-locally and the compile pipeline itself doesn't need a running container; spinning a 1–2 GB Java container for a 30-second compile is rarely the right trade. Flip the gate on if your task graph initialises the network connection at compile time (some plugins probe `chainId`, perform network-typed config validation, etc.).

`hardhat node` never auto-tears-down — the container has to outlive the `node` process for the dev RPC to be useful. Clean up with `docker rm -f <container-name>`; the wrapper logs the name on spawn so it's one copy-paste away.

## Notes

The plugin installs a global HTTP keep-alive agent at module load. This eliminates the per-request TCP handshake overhead on the thousands of `/wallet/*` round-trips a typical test suite makes against the local java-tron container. See [`src/runtime/http-agent.js`](src/runtime/http-agent.js) for the rationale and tuning notes.

## Patched FullNode.jar

The cheatcodes that mutate VM state — `setAccountBalance`, `setAccountCode`, `setAccountStorageAt`, `unlockAccounts`, `snapshot`, `revert` — call `tre_*` JSON-RPC methods that stock java-tron does not implement. They live on a custom `/tre` endpoint served by a patched `FullNode.jar` built from a minor java-tron fork. Each call returns `{ supported, ... }`, so tests can degrade cleanly when running against a stock node. A build pipeline for the patched jar lands later in the rollout.

## Signer rebalancing between test files

Tests draw from a pool of 10 deterministically-derived signers (Hardhat's well-known `test test test … junk` mnemonic, HD path `m/44'/60'/0'/0/i`). The deployer is index 0; the remaining nine are funded at first use via `tre_setAccountBalance` — a direct `AccountStore` write that sidesteps the witness budget capping the docker-compose pre-funding.

Long test runs spend down those balances. The `@openzeppelin/hardhat-tron/signers` subpath exposes `refundSigners(hre)`, which resets every cached signer back to its initial balance. Hooking it into a Mocha `afterEach` in test helpers keeps later files from inheriting depleted state from earlier ones. The call is idempotent (`tre_setAccountBalance` is a direct write, not a transfer) and parallelized — typical cost is one ~15 ms round-trip per fixture.

## License

[MIT](LICENSE)
