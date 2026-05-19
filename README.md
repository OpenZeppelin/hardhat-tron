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

## Notes

The plugin installs a global HTTP keep-alive agent at module load. This eliminates the per-request TCP handshake overhead on the thousands of `/wallet/*` round-trips a typical test suite makes against the local java-tron container. See [`src/runtime/http-agent.js`](src/runtime/http-agent.js) for the rationale and tuning notes.

## Patched FullNode.jar

The cheatcodes that mutate VM state — `setAccountBalance`, `setAccountCode`, `setAccountStorageAt`, `unlockAccounts`, `snapshot`, `revert` — call `tre_*` JSON-RPC methods that stock java-tron does not implement. They live on a custom `/tre` endpoint served by a patched `FullNode.jar` built from a minor java-tron fork. Each call returns `{ supported, ... }`, so tests can degrade cleanly when running against a stock node. A build pipeline for the patched jar lands later in the rollout.

## Signer rebalancing between test files

Tests draw from a pool of 10 deterministically-derived signers (Hardhat's well-known `test test test … junk` mnemonic, HD path `m/44'/60'/0'/0/i`). The deployer is index 0; the remaining nine are funded at first use via `tre_setAccountBalance` — a direct `AccountStore` write that sidesteps the witness budget capping the docker-compose pre-funding.

Long test runs spend down those balances. The `@openzeppelin/hardhat-tron/signers` subpath exposes `refundSigners(hre)`, which resets every cached signer back to its initial balance. Hooking it into a Mocha `afterEach` in test helpers keeps later files from inheriting depleted state from earlier ones. The call is idempotent (`tre_setAccountBalance` is a direct write, not a transfer) and parallelized — typical cost is one ~15 ms round-trip per fixture.

## License

[MIT](LICENSE)
