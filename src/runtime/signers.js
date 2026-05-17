//
// plugin/signers.js
//
// Real multi-signer support for the spike. Upstream OZ tests
// destructure 5-20 signers from `ethers.getSigners()` and connect
// contracts to them (`token.connect(alice).transfer(bob, ...)`).
// The single-key wrapper in the original `makeSigners` couldn't
// support that — `connect(alice)` returned the same key, so any test
// asserting on `msg.sender == alice` would fail.
//
// Approach:
//   - Derive N deterministic secp256k1 keys from the well-known
//     Hardhat mnemonic "test test test ... junk" at HD path
//     m/44'/60'/0'/0/i. TVM uses the same curve and key→address
//     derivation as Ethereum (only the prefix differs: 0x41 vs 0x00),
//     so the same key produces a deterministic TVM address.
//   - Index 0 is the TRE deployer (pre-funded by docker-compose's
//     `defaultBalance` env to 5e12 TRX = 5e18 sun). Indices 1..N-1
//     are funded via `tre_setAccountBalance` to the same balance.
//   - Each signer carries its own TronWeb instance bound to its
//     private key. `factory.connect(signer)` rebuilds the contract
//     facade with that TronWeb so subsequent `.method(...).send()`
//     calls sign with the right key on chain.
//   - signMessage / signTypedData operate offline via ethers.Wallet -
//     TVM verifies Ethereum-style RSV signatures identically (same
//     ECDSA curve, same hash algorithms), so OZ contracts that use
//     ECDSA.recover (e.g. ERC20Permit, ERC2612, ERC2771Forwarder)
//     accept these signatures unchanged.
//

const { ethers: ethersV6 } = require('ethers');
const { TronWeb } = require('tronweb');
const { sendCallTx, valueToCallValue } = require('./cheatcodes');

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
// Per-signer initial balance after funding. 5e18 sun ≈ 54% of
// Long.MAX_VALUE — generous enough for tests that pass parseEther("1")
// or parseEther("5") as value (we use 1 wei == 1 sun pass-through;
// see plugin/cheatcodes.js top-of-file). Tests passing values above
// Long.MAX_VALUE (parseEther("10") and up) will hit the TVM ceiling.
const DEFAULT_BALANCE_SUN = 5_000_000_000_000_000_000n;
const SIGNER_COUNT = 10;

// Cache so `getSigners()` returns the SAME array across calls in a
// single test run — fixtures and per-test setup re-call it many times.
let _cachedSigners = null;

function deriveKey(index) {
  const wallet = ethersV6.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return { privateKey: wallet.privateKey, publicKey: wallet.publicKey };
}

// EIP-55 checksummed hex address from a private key, using TVM's
// 0x41 prefix when computing the TronWeb base58 representation but
// returning the underlying 20-byte body as the "Ethereum-style"
// address (which is what OZ contracts see in msg.sender).
function addressesFromKey(pk) {
  const pkNo0x = pk.startsWith('0x') ? pk.slice(2) : pk;
  const tronAddress = TronWeb.address.fromPrivateKey(pkNo0x);
  const hex21 = TronWeb.address.toHex(tronAddress);
  const checksum = ethersV6.getAddress('0x' + hex21.slice(2));
  return { tronAddress, address: checksum };
}

// Match the deployer TronWeb's 300 s HTTP timeout (see
// plugin/tre-web.js:HTTP_TIMEOUT_MS rationale — TronWeb's default
// 30 s axios timeout drops occasional slow-tail txs in long parallel
// runs where java-tron's state-store/snapshot LinkedHashMap grows
// large enough to stall single txs well past two minutes). Each
// signer gets its own client, so each needs the same override.
const HTTP_TIMEOUT_MS = 300_000;

function buildTronWeb(hre, privateKey) {
  const { HttpProvider } = require('tronweb').providers;
  const url = hre.network.config.url.replace(/\/jsonrpc$/i, '');
  const pkNo0x = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const provider = new HttpProvider(url, HTTP_TIMEOUT_MS);
  return new TronWeb({ fullHost: provider, privateKey: pkNo0x });
}

// Build a signer object that mirrors ethers v6's Signer surface for
// the methods OZ tests actually use. `tronWeb` is the per-signer
// client; downstream `makeFacade(..., signer.tronWeb)` routes writes
// through it so transactions are SIGNED BY this signer's key.
function makeSigner(hre, privateKey, knownReceipts, waitForReceipt) {
  const { tronAddress, address } = addressesFromKey(privateKey);
  const tronWeb = buildTronWeb(hre, privateKey);
  // ethers.Wallet for offline signing - the key material is what
  // matters; the wallet is never connected to a provider.
  const wallet = new ethersV6.Wallet(privateKey);

  // Three modes:
  //   1. `data` non-empty → contract call (sendCallTx via
  //      /wallet/triggersmartcontract; signs with this signer's key).
  //      Used by upstream OZ tests that send arbitrary calldata
  //      without going through the contract proxy
  //      (AccessManager.behavior.js: `caller.sendTransaction({to,
  //      data})` to test target-revert paths).
  //   2. `data` empty + `value` > 0 → plain TRX transfer
  //      (tronWeb.trx.sendTransaction). 1 wei == 1 sun pass-through
  //      (see plugin/cheatcodes.js top-of-file) so values up to
  //      Long.MAX_VALUE (~9.22e18) work; larger values fail in TVM.
  //   3. degenerate (no data + zero/no value) → throw, since neither
  //      TVM endpoint accepts amount=0.
  async function sendTransaction({ to, value, data }) {
    const recipientBase58 = toBase58(to);
    // Routing:
    //   - `data` is undefined → plain TRX transfer (TransferContract).
    //     Requires value > 0; TVM rejects 0-amount transfers.
    //   - `data` is a hex string (even '0x') → TriggerSmartContract.
    //     `'0x'` invokes the target's fallback/receive with no
    //     calldata — tests use this to probe revert behavior on
    //     contracts with no fallback (RelayedCall input-format
    //     test expects `revertedWithoutReason` from such a probe).
    const hasDataField = typeof data === 'string';

    let txId;
    if (hasDataField) {
      txId = await sendCallTx(tronWeb, {
        fromBase58: tronAddress,
        toBase58: recipientBase58,
        data,
        value,
      });
    } else {
      // Plain TRX transfer (TransferContract). 1 wei == 1 sun pass-
      // through — see cheatcodes.js top-of-file unit-model comment.
      // TVM rejects amount=0 transfers AND rejects transfers whose
      // target is a contract address ("Cannot transfer TRX to a smart
      // contract"). Both are real chain-level constraints; we surface
      // them by letting java-tron reply with its native error instead
      // of fabricating an EVM-shaped TriggerSmartContract({data:'0x'})
      // workaround.
      const amount = valueToCallValue(value);
      if (amount <= 0) {
        throw new Error(
          'sendTransaction({to, value, data}) requires either a `data` field or a positive `value`. ' +
            'TVM rejects amount=0 plain transfers.',
        );
      }
      const sent = await tronWeb.trx.sendTransaction(recipientBase58, amount);
      if (!sent.result) {
        throw new Error(`sendTransaction failed: ${JSON.stringify(sent)}`);
      }
      txId = sent.txid || (sent.transaction && sent.transaction.txID);
    }

    // Plain TransferContract txs don't surface an `info.receipt`
    // object (the receipt field is a contract-execution shape).
    // Polling for it would time out at 60s. Skip the poll for
    // the transfer path and synthesize an empty info; the call
    // path still polls because it needs receipt.result/logs.
    const info = hasDataField ? await waitForReceipt(tronWeb, txId) : null;
    // Receipt-result semantics differ between TransferContract (plain
    // TRX) and TriggerSmartContract (any `data` field, even '0x').
    // Only the latter populates `info.receipt.result` with
    // 'SUCCESS'/'REVERT'/etc.; a plain transfer omits that field
    // entirely, so falling back to status:0 would falsely flag
    // every transfer as a revert. Gate the revert-throw on
    // `hasDataField` and let plain transfers through unconditionally
    // (broadcast-time validation already rejected any malformed
    // transfer).
    const succeeded = hasDataField
      ? info && info.receipt && info.receipt.result === 'SUCCESS'
      : true;
    // Outer-call metadata for the TVM ether-balance chai matcher.
    // Plain TRX transfers don't pay an energy fee (TVM charges the
    // bandwidth fee, which is small) — info is null on that path
    // so fall back to the broadcast result's TransferContract amount.
    // 1 wei == 1 sun (see plugin/cheatcodes.js top-of-file).
    const callValueSun = valueToCallValue(value);
    const feeSun = (info && info.fee) || 0;
    const energyFee = info && info.receipt && Number.isFinite(info.receipt.energy_fee) ? Number(info.receipt.energy_fee) : 0;
    const netFee = info && info.receipt && Number.isFinite(info.receipt.net_fee) ? Number(info.receipt.net_fee) : 0;
    const totalFeeSun = feeSun || (energyFee + netFee);
    const receipt = {
      hash: '0x' + txId,
      transactionHash: '0x' + txId,
      status: succeeded ? 1 : 0,
      blockNumber: info ? info.blockNumber : undefined,
      logs: [],
      feeSun: totalFeeSun,
      internalTransactions: (info && info.internal_transactions) || [],
    };
    knownReceipts.set(receipt.hash, receipt);
    if (hasDataField && !receipt.status) {
      // ethers convention: state-changing CALLS reject on revert (with
      // a `.data` field so chai-matchers' `revertedWithCustomError`
      // can decode it). Lazy-require buildRevertError to avoid the
      // ethers-bridge ↔ signers module-load cycle.
      const { buildRevertError } = require('./ethers-bridge');
      throw buildRevertError(txId, info);
    }
    // Project outer-call (from, to, valueSun) onto the response so
    // plugin/chai-matchers-tvm.js can account user→recipient value
    // flow without a historical state lookup. Lazy-require tronToHex
    // to avoid the ethers-bridge ↔ signers module-load cycle.
    const { tronToHex } = require('./ethers-bridge');
    return {
      hash: receipt.hash,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      from: tronToHex(tronAddress),
      to: tronToHex(recipientBase58),
      valueSun: callValueSun,
      feeSun: totalFeeSun,
      internalTransactions: receipt.internalTransactions,
      wait: async () => receipt,
    };
  }

  // Pre-compute and stash a CreateSmartContract tx for a future
  // `ethers.deployContract(name, args, this)` call. Returns the
  // checksummed EVM-style hex address that the deploy WILL land at
  // (computed locally by TronWeb as
  // `0x41 || keccak256(txID || ownerAddress)[12:]`, identical to the
  // formula java-tron's WalletUtil.generateContractAddress uses on the
  // node side). The next deployContract call with matching
  // (deployer, name, args) consumes the stashed tx and broadcasts it
  // verbatim, so the deployed address matches this prediction.
  //
  // Use case: OZ tests that pre-compute a contract's address to pass
  // it as an immutable constructor arg into ANOTHER contract (e.g.
  // GovernorTimelockCompound passes the predicted Governor address to
  // CompTimelock's immutable `admin`). Upstream OZ does this with
  // `getCreateAddress({from, nonce: nonce+1})` — broken on TVM because
  // (a) the formula differs and (b) `nonce` is meaningless. This
  // method is the TVM-correct equivalent.
  //
  // Caveats:
  //   - TronWeb's default `expiration` is 60s after build. Tests must
  //     submit within that window (in practice: the one or two
  //     intervening deploys take ms).
  //   - The stashed tx is consumed only by an EXACTLY MATCHING
  //     `(deployer, name, args)` key. Mismatches build a fresh tx —
  //     producing a DIFFERENT contract address than the prediction.
  async function predictAddress(name, args = [], opts = {}) {
    const bridge = require('./ethers-bridge');
    const deploy = require('./deploy');
    const { ethers: ethersV6 } = require('ethers');
    const artifact = bridge.loadArtifact(opts.hre || global.hre || require('hardhat'), name);
    const ctor = artifact.abi.find(a => a.type === 'constructor');
    const ctorInputCount = ctor ? ctor.inputs.length : 0;
    // Mirror `deployViaFacade`'s overrides-splitting so the cache key
    // and the eventual broadcast see the same ctor-arg shape.
    const trailing = args[args.length - 1];
    const overrideKeys = ['value', 'gasLimit', 'gasPrice', 'nonce', 'from', 'maxFeePerGas', 'maxPriorityFeePerGas'];
    const hasOverrides =
      trailing && typeof trailing === 'object' && !Array.isArray(trailing) &&
      overrideKeys.some(k => k in trailing) && args.length > ctorInputCount;
    const overrides = hasOverrides ? trailing : {};
    const ctorArgs = hasOverrides ? args.slice(0, -1) : args;

    // Build TronWeb's `parameters` array (normalize addresses,
    // ethers.Typed wrappers, bigints) the same way deployViaFacade does.
    let parameters;
    if (ctorArgs.length > 0 && ctor) {
      parameters = ctor.inputs.map((input, i) => bridge.normalizeArg(ctorArgs[i], input));
    }

    const deployOpts = { parameters };
    if (overrides.value != null) {
      const { valueToCallValue } = require('./cheatcodes');
      const cv = valueToCallValue(overrides.value);
      deployOpts.callValue = typeof cv === 'bigint' ? cv.toString() : cv;
    }
    if (overrides.gasLimit != null) {
      deployOpts.feeLimit = Math.max(1, Math.min(1_000_000_000, Number(BigInt(overrides.gasLimit)) * 100));
    }

    const { signedTx, predictedAddressTron } = await deploy.prebuildDeploy(
      tronWeb,
      tronAddress,
      artifact,
      deployOpts,
    );
    bridge._prebuildCache.set(
      bridge.prebuildCacheKey(tronAddress, name, args),
      { signedTx },
    );
    // TVM stores `contract_address` as 0x41+20 hex; strip the prefix
    // and apply EIP-55 checksumming so the value compares cleanly
    // against ethers' equally-checksummed read paths (e.g. the
    // `await mock.timelock()` chai assertion).
    const hex20 = predictedAddressTron.startsWith('41') ? predictedAddressTron.slice(2) : predictedAddressTron;
    return ethersV6.getAddress('0x' + hex20);
  }

  const signer = {
    address,
    tronAddress,
    privateKey,
    publicKey: wallet.signingKey.publicKey,
    tronWeb,
    provider: null, // filled in by the bridge so stubProvider stays the source of truth

    getAddress: async () => address,
    sendTransaction,
    predictAddress,

    // EIP-191 personal_sign. TVM's `Tron Signed Message:` prefix is
    // NOT used here - OZ contracts that verify off-chain signatures
    // use `\x19Ethereum Signed Message:\n` (via OZ's MessageHashUtils.
    // toEthSignedMessageHash). ethers.Wallet.signMessage produces that
    // exact format, so signatures verify on-chain unchanged.
    signMessage: async msg => wallet.signMessage(msg),

    // EIP-712 typed data. Domain separator includes chainId, which
    // for TVM on TRE is the network chain ID returned by eth_chainId
    // on the /jsonrpc endpoint. Callers (test/helpers/eip712.js) read
    // it from the contract via `eip712Domain()` so the signature
    // matches the contract's view of the domain.
    signTypedData: async (domain, types, value) => wallet.signTypedData(domain, types, value),

    // Tests sometimes do `signer.connect(provider)` to rebind to a
    // specific provider - we return the same signer since our provider
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
// first call from a test run does the funding; subsequent calls reuse
// the cached array.
//
// Funding is parallelized: tre_setAccountBalance is a direct AccountStore
// mutation (not a transfer), so each call is independent — no ordering
// constraint, no shared mutable state across keys. Sequential funding
// paid ~10×RTT (80-150 ms) at the start of every fresh fixture; in
// parallel that's a single ~10-15 ms wave. The HTTP keep-alive agent
// (plugin/http-agent.js) caps maxSockets at 50 so 10 concurrent
// requests share the same warm connection pool.
async function buildSigners(hre, deps) {
  if (_cachedSigners) return _cachedSigners;

  const { setAccountBalance } = require('./cheatcodes');
  const { tronWeb: deployerTronWeb } = hre.tre.makeTronWeb();

  const signers = [];
  for (let i = 0; i < SIGNER_COUNT; i++) {
    // Index 0 = the deployer key (already in hardhat.config.cjs).
    // Use the configured key directly so the deployer's tronAddress
    // matches what the rest of the bridge sees.
    let pk;
    if (i === 0) {
      const raw = hre.network.config.accounts[0];
      pk = raw.startsWith('0x') ? raw : '0x' + raw;
    } else {
      pk = deriveKey(i).privateKey;
    }
    signers.push(makeSigner(hre, pk, deps.knownReceipts, deps.waitForReceipt));
  }

  // Fund every signer to DEFAULT_BALANCE_SUN (including i==0). The
  // docker-compose entrypoint pre-funded account 0 to 1e9 TRX =
  // 1e15 sun from the genesis witness, but under the 1-wei-==-1-sun
  // pass-through model (plugin/cheatcodes.js top-of-file), tests
  // expect parseEther-scale balances (>=1e18 sun) per signer.
  // tre_setAccountBalance mutates AccountStore directly so it
  // sidesteps the witness budget that limits docker's per-account
  // sweep to ~1e10 TRX total. Idempotent — safe across reruns AND
  // safe to run concurrently (each call writes a distinct key).
  const results = await Promise.all(
    signers.map(s => setAccountBalance(deployerTronWeb, s.tronAddress, String(DEFAULT_BALANCE_SUN))),
  );
  for (let i = 0; i < results.length; i++) {
    if (!results[i].supported) {
      throw new Error(`buildSigners: tre_setAccountBalance failed for index ${i}: ${results[i].reason}`);
    }
  }

  _cachedSigners = signers;
  return signers;
}

// Re-fund all known signers to DEFAULT_BALANCE_SUN. Called by
// loadFixture before each FRESH fixture so cross-file tests don't
// inherit a depleted state from a prior file's spending. Idempotent
// at the cheatcode level (tre_setAccountBalance directly sets balance,
// no transfer). No-op if signers haven't been built yet.
//
// Parallelized for the same reason as buildSigners: each call writes a
// distinct AccountStore key, so concurrency is safe and removes ~9×RTT
// from the critical path of every fresh fixture.
async function refundSigners(hre) {
  if (!_cachedSigners) return;
  const { setAccountBalance } = require('./cheatcodes');
  const { tronWeb: deployerTronWeb } = hre.tre.makeTronWeb();
  const results = await Promise.all(
    _cachedSigners.map(s => setAccountBalance(deployerTronWeb, s.tronAddress, String(DEFAULT_BALANCE_SUN))),
  );
  for (let i = 0; i < results.length; i++) {
    if (!results[i].supported) {
      throw new Error(`refundSigners: tre_setAccountBalance failed for ${_cachedSigners[i].tronAddress}: ${results[i].reason}`);
    }
  }
}

// Test-time reset hook. The signer set persists across `loadFixture`
// re-runs by design (deterministic keys + pre-funded accounts), but
// the spike's smoke tests want to force a fresh derivation.
function _resetCache() {
  _cachedSigners = null;
}

module.exports = {
  buildSigners,
  refundSigners,
  toBase58,
  _resetCache,
  HARDHAT_MNEMONIC,
};
