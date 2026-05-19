'use strict';

// Multi-signer support for tests. The plugin derives N deterministic
// secp256k1 keys from the well-known Hardhat mnemonic
// "test test test … junk" at HD path `m/44'/60'/0'/0/i` and funds
// each via `tre_setAccountBalance` on first use. TVM uses the same
// curve and key→address derivation as Ethereum (only the address
// prefix differs: 0x41 vs 0x00), so a given private key produces a
// deterministic TVM base58 address.
//
// Each signer carries its own TronWeb instance bound to its private
// key. `signMessage` / `signTypedData` operate offline via
// `ethers.Wallet` — TVM verifies Ethereum-style RSV signatures
// identically (same ECDSA curve, same hash algorithms), so contracts
// that use `ECDSA.recover` (e.g. `ERC20Permit`, `ERC2771Forwarder`)
// accept these signatures unchanged.
//
// State-changing call paths (`sendTransaction`, contract-factory
// binding via `connect`) layer on top of the ethers bridge and land
// in its module.

const { ethers: ethersV6 } = require('ethers');
const { TronWeb } = require('tronweb');

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

// Per-signer initial balance after funding. 5e18 sun ≈ 54% of
// Long.MAX_VALUE — generous enough for tests that pass parseEther
// values up to ~5 under the TVM pass-through unit model
// (1 wei == 1 sun on the JS↔TVM boundary). Tests passing values
// above Long.MAX_VALUE hit the TVM ceiling regardless of funding.
const DEFAULT_BALANCE_SUN = 5_000_000_000_000_000_000n;
const SIGNER_COUNT = 10;

// Match the deployer TronWeb's 300 s HTTP timeout (see
// `src/runtime/tre-web.js`). Each signer gets its own TronWeb
// client, so each needs the same override.
const HTTP_TIMEOUT_MS = 300_000;

// Cache so `buildSigners()` returns the SAME array across calls in a
// single test run — fixtures and per-test setup re-call it many times.
let _cachedSigners = null;

function deriveKey(index) {
  const wallet = ethersV6.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return { privateKey: wallet.privateKey, publicKey: wallet.publicKey };
}

// EIP-55 checksummed hex address from a private key, alongside the
// underlying base58 TVM address. The 20-byte body is what contracts
// see in `msg.sender` (after TVM's `0x41` prefix is stripped).
function addressesFromKey(pk) {
  const pkNo0x = pk.startsWith('0x') ? pk.slice(2) : pk;
  const tronAddress = TronWeb.address.fromPrivateKey(pkNo0x);
  const hex21 = TronWeb.address.toHex(tronAddress);
  const checksum = ethersV6.getAddress('0x' + hex21.slice(2));
  return { tronAddress, address: checksum };
}

function buildTronWeb(hre, privateKey) {
  const { HttpProvider } = require('tronweb').providers;
  const url = hre.network.config.url.replace(/\/jsonrpc$/i, '');
  const pkNo0x = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const provider = new HttpProvider(url, HTTP_TIMEOUT_MS);
  return new TronWeb({ fullHost: provider, privateKey: pkNo0x });
}

// Signer object mirroring the ethers v6 Signer surface for the
// methods OZ tests reach for. The `tronWeb` field is the per-signer
// client; the bridge later wires `factory.connect(signer)` to route
// writes through it so transactions sign with this signer's key.
function makeSigner(hre, privateKey) {
  const { tronAddress, address } = addressesFromKey(privateKey);
  const tronWeb = buildTronWeb(hre, privateKey);
  // `ethers.Wallet` for offline signing — the key material is what
  // matters; the wallet is never connected to a provider.
  const wallet = new ethersV6.Wallet(privateKey);

  const signer = {
    address,
    tronAddress,
    privateKey,
    publicKey: wallet.signingKey.publicKey,
    tronWeb,
    // Filled in by the bridge so its stub provider stays the single
    // source of truth for read-side queries.
    provider: null,

    getAddress: async () => address,

    // EIP-191 personal_sign. TVM's "Tron Signed Message:" prefix is
    // NOT used here — contracts that verify off-chain signatures use
    // `\x19Ethereum Signed Message:\n` (via OZ's
    // `MessageHashUtils.toEthSignedMessageHash`). `ethers.Wallet
    // .signMessage` produces that exact format, so signatures verify
    // on-chain unchanged.
    signMessage: async (msg) => wallet.signMessage(msg),

    // EIP-712 typed data. Domain separator includes chainId, which
    // for TVM on TRE is the network chain ID returned by
    // `eth_chainId` on the `/jsonrpc` endpoint. Callers typically
    // read it from the contract via `eip712Domain()` so the
    // signature matches the contract's view of the domain.
    signTypedData: async (domain, types, value) => wallet.signTypedData(domain, types, value),

    // Tests sometimes do `signer.connect(provider)` to rebind to a
    // specific provider; return the same signer since our provider
    // is global.
    connect: () => signer,
  };
  return signer;
}

function toBase58(value) {
  if (!value) return value;
  if (typeof value === 'object' && typeof value.tronAddress === 'string') return value.tronAddress;
  if (typeof value === 'object' && typeof value.address === 'string') return toBase58(value.address);
  if (typeof value !== 'string') return value;
  if (value.startsWith('T') && value.length === 34) return value;
  if (value.startsWith('0x') && value.length === 42) {
    return TronWeb.address.fromHex('41' + value.slice(2));
  }
  return value;
}

// Lazy-build N signers and fund each via `tre_setAccountBalance`. The
// first call from a test run does the funding; subsequent calls
// reuse the cached array.
//
// Funding is parallelized: `tre_setAccountBalance` is a direct
// `AccountStore` mutation (not a transfer), so each call is
// independent — no ordering constraint, no shared mutable state
// across keys. Sequential funding would pay ~10×RTT (80–150 ms) at
// the start of every fresh fixture; in parallel that's a single
// ~10–15 ms wave. The HTTP keep-alive agent caps `maxSockets` at 50
// so 10 concurrent requests share the same warm connection pool.
async function buildSigners(hre) {
  if (_cachedSigners) return _cachedSigners;

  const { setAccountBalance } = require('./cheatcodes');
  const { tronWeb: deployerTronWeb } = hre.tre.makeTronWeb();

  const signers = [];
  for (let i = 0; i < SIGNER_COUNT; i++) {
    // Index 0 = the deployer key (already in `hardhat.config.cjs`).
    // Use the configured key directly so the deployer's tronAddress
    // matches what the rest of the bridge sees.
    let pk;
    if (i === 0) {
      const raw = hre.network.config.accounts[0];
      pk = raw.startsWith('0x') ? raw : '0x' + raw;
    } else {
      pk = deriveKey(i).privateKey;
    }
    signers.push(makeSigner(hre, pk));
  }

  // Fund every signer to `DEFAULT_BALANCE_SUN` (including index 0).
  // The docker-compose entrypoint pre-funds account 0 from the
  // genesis witness, but the witness budget caps the per-account
  // sweep below parseEther-scale balances. `tre_setAccountBalance`
  // mutates `AccountStore` directly so it sidesteps that ceiling.
  // Idempotent — safe across reruns and safe to run concurrently
  // (each call writes a distinct key).
  const results = await Promise.all(
    signers.map((s) => setAccountBalance(deployerTronWeb, s.tronAddress, String(DEFAULT_BALANCE_SUN))),
  );
  for (let i = 0; i < results.length; i++) {
    if (!results[i].supported) {
      throw new Error(`buildSigners: tre_setAccountBalance failed for index ${i}: ${results[i].reason}`);
    }
  }

  _cachedSigners = signers;
  return signers;
}

// Re-fund all known signers to `DEFAULT_BALANCE_SUN`. Called by
// `loadFixture` (and explicitly between test files) so cross-file
// runs don't inherit a depleted state from a prior file's spending.
// Idempotent at the cheatcode level (`tre_setAccountBalance` is a
// direct write, not a transfer). No-op if signers haven't been
// built yet.
//
// Parallelized for the same reason as `buildSigners`: each call
// writes a distinct `AccountStore` key, so concurrency is safe and
// removes ~9×RTT from the critical path of every fresh fixture.
async function refundSigners(hre) {
  if (!_cachedSigners) return;
  const { setAccountBalance } = require('./cheatcodes');
  const { tronWeb: deployerTronWeb } = hre.tre.makeTronWeb();
  const results = await Promise.all(
    _cachedSigners.map((s) => setAccountBalance(deployerTronWeb, s.tronAddress, String(DEFAULT_BALANCE_SUN))),
  );
  for (let i = 0; i < results.length; i++) {
    if (!results[i].supported) {
      throw new Error(
        `refundSigners: tre_setAccountBalance failed for ${_cachedSigners[i].tronAddress}: ${results[i].reason}`,
      );
    }
  }
}

// Test-time reset hook. The signer set persists across `loadFixture`
// re-runs by design (deterministic keys + pre-funded accounts), but
// callers may want to force a fresh derivation.
function _resetCache() {
  _cachedSigners = null;
}

module.exports = {
  buildSigners,
  refundSigners,
  toBase58,
  _resetCache,
  HARDHAT_MNEMONIC,
  DEFAULT_BALANCE_SUN,
  SIGNER_COUNT,
};
