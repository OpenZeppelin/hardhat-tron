'use strict';

// Wrappers around the patched java-tron image's `tre_*` JSON-RPC
// methods plus raw-HTTP helpers for transactions the ethers bridge
// needs to issue without going through TronWeb's contract proxy
// (impersonated owner_address, raw calldata, BigInt-safe call_value).
// `tre_*` cheatcodes live on the `/tre` endpoint — the `/jsonrpc`
// endpoint is the EVM-compat shim and does not expose `tre_*`.

const { TronWeb } = require('tronweb');

async function rpcCall(tronWeb, method, params = []) {
  const url = tronWeb.fullNode.host.replace(/\/$/, '') + '/tre';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

// Surface "method not found" cleanly so callers can degrade rather
// than throw. An unpatched fork returns an error object; cheatcodes
// the patched fork supports return `{ supported: true, result }`.
async function callOrFalse(tronWeb, method, params = []) {
  const r = await rpcCall(tronWeb, method, params).catch((e) => ({
    error: { message: e.message },
  }));
  if (r.error) return { supported: false, reason: r.error.message };
  return { supported: true, result: r.result };
}

const mine = (tw) => callOrFalse(tw, 'tre_mine', []);
const setBlockTime = (tw, seconds) => callOrFalse(tw, 'tre_blockTime', [seconds]);

// State snapshot / revert — depends on the patched FullNode.jar.
// The patch dumps (accountStore, codeStore, contractStore,
// storageRowStore) into an in-memory map keyed by a returned id
// ("0x1", "0x2", …). Revert restores the dumped state and discards
// the snapshot id and any newer ids (matches Hardhat's `evm_revert`
// semantics).
//
// Block number / timestamp are intentionally NOT rolled back. Tests
// can rely on monotonically advancing blocks, but should re-warp
// time after revert if they need a specific timestamp.
const snapshot = (tw) => callOrFalse(tw, 'tre_snapshot', []);
const revert = (tw, id) => callOrFalse(tw, 'tre_revert', [id]);

// Account-state mutators. Each writes directly to the patched
// FullNode's account / code / storage stores via `tre_*` JSON-RPC.
//
// `sun` is stringified before transport because TVM balances can
// exceed 2^53 (Long.MAX_VALUE ≈ 9.22e18 sun); JSON-RPC integer
// literals above 2^53 lose precision in the JS → Java round-trip
// unless they go over the wire as strings.
const setAccountBalance = (tw, addr, sun) => callOrFalse(tw, 'tre_setAccountBalance', [addr, String(sun)]);
const setAccountCode = (tw, addr, code) => callOrFalse(tw, 'tre_setAccountCode', [addr, code]);
const setAccountStorageAt = (tw, addr, slot, value) => callOrFalse(tw, 'tre_setAccountStorageAt', [addr, slot, value]);

// `unlockAccounts` adds a list of base58 addresses to a per-session
// whitelist consulted by `TransactionCapsule.validateSignature`. Any
// tx whose `owner_address` is on the list is accepted regardless of
// which key signed it. Used by tests that need to send from accounts
// they don't hold the private key for.
const unlockAccounts = (tw, addrs) => callOrFalse(tw, 'tre_unlockedAccounts', [addrs]);

// Impersonation primitives. `tre_impersonateAccount` adds an address
// to a static whitelist on `TransactionCapsule.validateSignature`,
// so subsequent txs whose `owner_address` is on the list skip
// ECRecover + permission/weight checks. Pair each server-side
// impersonate with a `registerLocalImpersonation` so the bridge
// signer set mirrors the server view — they MUST stay in sync.
const impersonateAccount = (tw, addr) => callOrFalse(tw, 'tre_impersonateAccount', [addr]);
const stopImpersonatingAccount = (tw, addr) => callOrFalse(tw, 'tre_stopImpersonatingAccount', [addr]);

const _localImpersonations = new Set();
function registerLocalImpersonation(base58) {
  _localImpersonations.add(base58);
}
function unregisterLocalImpersonation(base58) {
  _localImpersonations.delete(base58);
}
function isLocallyImpersonated(base58) {
  return _localImpersonations.has(base58);
}

// -- Unit model and BigInt-safe JSON serialization ----------------
//
// 1 wei == 1 sun (pass-through, no conversion). EVM uses 1e18 wei
// per native unit and TVM uses 1e6 sun; converting at the JS↔TVM
// boundary seemed natural at first, but it breaks any test where
// Solidity STORES a value and re-uses it later (a Governor that
// stores `value` at propose-time and re-emits it at execute-time
// would try to send the converted figure, but the funding only
// matched the pre-conversion one).
//
// Pass-through 1:1 sidesteps the issue entirely: what JS sends,
// what Solidity stores, and what TVM debits are the same number.
// `value` is bounded by Java's `Long` (`Long.MAX_VALUE` ≈ 9.22e18
// sun), so tests using `parseEther("10")` and above will hit that
// ceiling — verified ≤9e18 round-trips cleanly through
// `/wallet/triggersmartcontract`'s `call_value` field.
const WEI_PER_SUN = 1n;

function weiToSun(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0);
}

// Coerce a value override (possibly undefined / Number / BigInt /
// hex string) to a BigInt. java-tron's
// `/wallet/triggersmartcontract` declares `call_value` as a Long
// and accepts JSON integer literals up to `Long.MAX_VALUE` exactly
// (the server-side parser handles integers natively, NOT as
// IEEE-754 doubles). Callers that JSON-stringify the result MUST
// use `jsonStringifyWithBigInts` to splice the BigInt in as a raw
// JSON integer literal; round-tripping through JS `Number` would
// quantize anything above 2^53 and silently shift transferred
// amounts by ±1 wei.
function valueToCallValue(value) {
  if (value == null) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

// `JSON.stringify` throws on BigInt; sending `Number(bigint)` loses
// precision above 2^53. Tag each BigInt with a sentinel string and
// rewrite the sentinels with raw integer literals before returning.
// Sentinel uses ASCII alphanumerics + underscores so it never gets
// JSON-escaped — the regex-replace round-trips cleanly.
function jsonStringifyWithBigInts(obj) {
  const SENTINEL_PREFIX = 'XBI_';
  const SENTINEL_SUFFIX = '_BIX';
  const replacer = (_, v) => (typeof v === 'bigint' ? SENTINEL_PREFIX + v.toString() + SENTINEL_SUFFIX : v);
  const raw = JSON.stringify(obj, replacer);
  return raw.replace(new RegExp('"' + SENTINEL_PREFIX + '(-?\\d+)' + SENTINEL_SUFFIX + '"', 'g'), '$1');
}

// -- Raw HTTP transaction helpers ---------------------------------
//
// Send a TVM tx with arbitrary calldata (selector + abi-encoded
// args) and optional msg.value. Bypasses TronWeb's high-level
// contract proxy so the caller can control `owner_address` (used
// for impersonation) and pass raw `data` bytes when the ABI isn't
// known to the bridge.
//
// `multisig: true` skips TronWeb's owner-key vs private-key check
// inside `trx.sign` — required when the impersonated owner address
// doesn't match the signing key. The patched
// `TransactionCapsule.validateSignature` still accepts the tx via
// the impersonation registry bypass.
async function sendCallTx(tronWeb, { fromBase58, toBase58, data, value = 0n, multisig = false, feeLimit }) {
  const base = tronWeb.fullNode.host.replace(/\/$/, '');
  const dataHex = typeof data === 'string' && data.startsWith('0x') ? data.slice(2) : data || '';
  const triggerResp = await fetch(base + '/wallet/triggersmartcontract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonStringifyWithBigInts({
      owner_address: TronWeb.address.toHex(fromBase58),
      contract_address: TronWeb.address.toHex(toBase58),
      // When `data` is supplied directly (no function_selector),
      // java-tron's TriggerSmartContract handler uses it verbatim
      // as the transaction's `data` field — so we don't need to
      // know the function signature to send raw calldata.
      data: dataHex,
      // Caller-provided `feeLimit` (sun) honors `overrides.gasLimit`
      // from chai-matchers tests that probe OOG paths; default to
      // TRE's hard cap of 1_000_000_000 sun (≈ 10M energy @ 100
      // sun/energy) when unset.
      fee_limit: feeLimit != null ? Number(feeLimit) : 1_000_000_000,
      call_value: valueToCallValue(value),
      visible: false,
    }),
  });

  const triggerJson = await triggerResp.json();
  if (!triggerJson.transaction || (triggerJson.result && triggerJson.result.code)) {
    throw new Error(`triggersmartcontract failed: ${JSON.stringify(triggerJson)}`);
  }

  const signed = await tronWeb.trx.sign(triggerJson.transaction, undefined, undefined, multisig);

  const broadcastResp = await fetch(base + '/wallet/broadcasttransaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  const broadcastJson = await broadcastResp.json();
  if (!broadcastJson.result) {
    const code = broadcastJson.code || broadcastJson.message || JSON.stringify(broadcastJson);
    const hint = /SIGERROR|signature/i.test(String(code))
      ? ' (impersonation requires the patched TransactionCapsule)'
      : '';
    throw new Error(`broadcast failed: ${code}${hint}`);
  }
  return signed.txID || broadcastJson.txid;
}

// Plain TRX transfer (TransferContract) with optional impersonated
// owner. Builds via `/wallet/createtransaction`, signs with
// `multisig` to bypass TronWeb's owner-key check, broadcasts.
async function sendTransferTx(tronWeb, { fromBase58, toBase58, value, multisig = false }) {
  const base = tronWeb.fullNode.host.replace(/\/$/, '');
  const amount = valueToCallValue(value);
  if (amount <= 0) {
    throw new Error('sendTransferTx: amount must be > 0 — TVM rejects 0-amount transfers');
  }
  const createResp = await fetch(base + '/wallet/createtransaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonStringifyWithBigInts({
      owner_address: TronWeb.address.toHex(fromBase58),
      to_address: TronWeb.address.toHex(toBase58),
      amount,
      visible: false,
    }),
  });
  const createJson = await createResp.json();
  if (!createJson.txID) {
    throw new Error(`createtransaction failed: ${JSON.stringify(createJson)}`);
  }
  const signed = await tronWeb.trx.sign(createJson, undefined, undefined, multisig);
  const broadcastResp = await fetch(base + '/wallet/broadcasttransaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  const broadcastJson = await broadcastResp.json();
  if (!broadcastJson.result) {
    throw new Error(
      `broadcast failed: ${broadcastJson.code || broadcastJson.message || JSON.stringify(broadcastJson)}`,
    );
  }
  return signed.txID || broadcastJson.txid;
}

module.exports = {
  rpcCall,
  callOrFalse,
  mine,
  setBlockTime,
  snapshot,
  revert,
  setAccountBalance,
  setAccountCode,
  setAccountStorageAt,
  unlockAccounts,
  impersonateAccount,
  stopImpersonatingAccount,
  registerLocalImpersonation,
  unregisterLocalImpersonation,
  isLocallyImpersonated,
  WEI_PER_SUN,
  weiToSun,
  valueToCallValue,
  jsonStringifyWithBigInts,
  sendCallTx,
  sendTransferTx,
};
