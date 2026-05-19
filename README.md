# @openzeppelin/hardhat-tron

Hardhat plugin for compiling and deploying Solidity contracts to the TRON Virtual Machine.

> **Status: work in progress.** The public API is unstable until the `0.1.0` release.

## Notes

The plugin installs a global HTTP keep-alive agent at module load. This eliminates the per-request TCP handshake overhead on the thousands of `/wallet/*` round-trips a typical test suite makes against the local java-tron container. See [`src/runtime/http-agent.js`](src/runtime/http-agent.js) for the rationale and tuning notes.

## Patched FullNode.jar

The cheatcodes that mutate VM state — `setAccountBalance`, `setAccountCode`, `setAccountStorageAt`, `unlockAccounts`, `snapshot`, `revert` — call `tre_*` JSON-RPC methods that stock java-tron does not implement. They live on a custom `/tre` endpoint served by a patched `FullNode.jar` built from a minor java-tron fork. Each call returns `{ supported, ... }`, so tests can degrade cleanly when running against a stock node. A build pipeline for the patched jar lands later in the rollout.

## License

[MIT](LICENSE)
