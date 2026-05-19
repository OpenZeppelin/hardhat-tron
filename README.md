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

## Notes

The plugin installs a global HTTP keep-alive agent at module load. This eliminates the per-request TCP handshake overhead on the thousands of `/wallet/*` round-trips a typical test suite makes against the local java-tron container. See [`src/runtime/http-agent.js`](src/runtime/http-agent.js) for the rationale and tuning notes.

## Patched FullNode.jar

The cheatcodes that mutate VM state — `setAccountBalance`, `setAccountCode`, `setAccountStorageAt`, `unlockAccounts`, `snapshot`, `revert` — call `tre_*` JSON-RPC methods that stock java-tron does not implement. They live on a custom `/tre` endpoint served by a patched `FullNode.jar` built from a minor java-tron fork. Each call returns `{ supported, ... }`, so tests can degrade cleanly when running against a stock node. A build pipeline for the patched jar lands later in the rollout.

## Signer rebalancing between test files

Tests draw from a pool of 10 deterministically-derived signers (Hardhat's well-known `test test test … junk` mnemonic, HD path `m/44'/60'/0'/0/i`). The deployer is index 0; the remaining nine are funded at first use via `tre_setAccountBalance` — a direct `AccountStore` write that sidesteps the witness budget capping the docker-compose pre-funding.

Long test runs spend down those balances. The `@openzeppelin/hardhat-tron/signers` subpath exposes `refundSigners(hre)`, which resets every cached signer back to its initial balance. Hooking it into a Mocha `afterEach` in test helpers keeps later files from inheriting depleted state from earlier ones. The call is idempotent (`tre_setAccountBalance` is a direct write, not a transfer) and parallelized — typical cost is one ~15 ms round-trip per fixture.

## License

[MIT](LICENSE)
