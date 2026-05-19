# @openzeppelin/hardhat-tron

Hardhat plugin for compiling and deploying Solidity contracts to the TRON Virtual Machine.

> **Status: work in progress.** The public API is unstable until the `0.1.0` release.

## Notes

The plugin installs a global HTTP keep-alive agent at module load. This eliminates the per-request TCP handshake overhead on the thousands of `/wallet/*` round-trips a typical test suite makes against the local java-tron container. See [`src/runtime/http-agent.js`](src/runtime/http-agent.js) for the rationale and tuning notes.

## License

[MIT](LICENSE)
