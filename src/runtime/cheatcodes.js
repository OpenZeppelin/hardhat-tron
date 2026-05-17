//
// plugin/cheatcodes.js
//
// Wrappers around tronbox/tre's `tre_*` JSON-RPC methods.
//
// All cheatcodes live on the `/tre` endpoint, NOT the `/jsonrpc`
// endpoint. `/jsonrpc` is the EVM-compat shim and does not expose
// `tre_*`.
//
// Methods documented in the tronbox/tre image (CHANGELOG v3.0.0+):
//   tre_mine, tre_blockTime, tre_unlockedAccounts,
//   tre_setAccountBalance, tre_setAccountCode, tre_setAccountStorageAt
//

const { TronWeb } = require('tronweb');

// Unit model: 1 wei == 1 sun (pass-through, no conversion).
//
// Prior versions divided wei by 1e12 to convert to sun at the JS↔TVM
// boundary. That seemed natural — EVM uses 1e18 wei per native unit,
// TVM uses 1e6 sun — but it broke any test where Solidity STORES a
// value and re-uses it later. Example: Governor.propose(target, value,
// calldata) stores `value` raw; Governor.execute() then does
// `target.call{value: value}(calldata)`. If the bridge converted at
// propose-time but Solidity stored the pre-conversion value (which it
// must — Solidity has no concept of our conversion), execute would
// try to send 1e18 sun while the funding only provided 1e6 sun, and
// the inner call would revert with FailedCall().
//
// Pass-through 1:1 sidesteps the issue entirely: what JS sends, what
// Solidity stores, and what TVM debits are all the same number. The
// cost is that `value` is bounded by Java's `long` (Long.MAX_VALUE ≈
// 9.22e18 sun), so tests using parseEther("10") and above will hit
// the ceiling. Empirically verified ≤9e18 round-trips cleanly through
// /wallet/triggersmartcontract's `call_value` field (Number coercion
// from BigInt is exact for any value ≤ 2^53, AND TVM also accepts
// any value ≤ Long.MAX_VALUE since the JSON parser treats integers
// as Long natively).
//
// Kept as exports for backwards compat with any older caller, but the
// internal helpers below no longer use them — values pass through
// untouched via `Number(BigInt(v))`.
const WEI_PER_SUN = 1n;

function weiToSun(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0);
}

// Coerce a value override (possibly undefined / number / bigint / hex
// string) to a BigInt. Java-tron's /wallet/triggersmartcontract
// declares `call_value` as a Long and accepts JSON integer literals
// up to Long.MAX_VALUE precisely (the server-side JSON parser handles
// integers natively, NOT as IEEE-754 doubles). We MUST avoid round-
// tripping through JavaScript `Number` here: `Number(999999999999999999n)
// === 1000000000000000000` (rounds up over 2^53), which silently turns
// a `sendValue(recipient, funds - 1)` test into "send the whole funds"
// — see test/utils/Address.test.js's "sends non-zero amounts" diff of
// exactly 1 wei. Callers that JSON-stringify the result use
// `serializeCallValueIntoJson` below to splice the BigInt in as a raw
// JSON integer literal.
function valueToCallValue(value) {
  if (value == null) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

// JSON serializer that handles BigInt by embedding a placeholder during
// stringify and substituting the BigInt's decimal representation into
// the resulting string. JSON.stringify throws on BigInt; sending
// `Number(bigint)` loses precision above 2^53. We tag each BigInt with
// a sentinel string and rewrite the sentinels with raw integer
// literals before returning. Used by the request builders below so
// values up to Long.MAX_VALUE survive the JS→JSON→Java pipeline.
function jsonStringifyWithBigInts(obj) {
  // Sentinel must contain only characters that JSON.stringify never
  // escapes, so the regex-replace step round-trips cleanly. ASCII
  // alphanumerics + underscores are always safe.
  const SENTINEL_PREFIX = 'XBI_';
  const SENTINEL_SUFFIX = '_BIX';
  const replacer = (_, v) => (typeof v === 'bigint' ? SENTINEL_PREFIX + v.toString() + SENTINEL_SUFFIX : v);
  const raw = JSON.stringify(obj, replacer);
  return raw.replace(new RegExp('"' + SENTINEL_PREFIX + '(-?\\d+)' + SENTINEL_SUFFIX + '"', 'g'), '$1');
}

// Send a TVM tx with arbitrary calldata (selector + abi-encoded
// args) and optional msg.value. Bypasses TronWeb's high-level
// contract proxy so the caller can:
//   - control owner_address (used for impersonation)
//   - pass raw `data` bytes when the ABI isn't known to the bridge
//     (e.g. `signer.sendTransaction({to, data})` from a test)
//
// Flow: POST /wallet/triggersmartcontract → tronWeb.trx.sign →
// POST /wallet/broadcasttransaction. Returns the tx hash (no 0x
// prefix). Caller is responsible for waitForReceipt.
//
// `multisig: true` skips TronWeb's owner-key vs private-key check
// inside `trx.sign` — required when the impersonated owner_address
// doesn't match the signing key (the patched fork's
// TransactionCapsule.validateSignature still accepts the tx via the
// TreImpersonationRegistry bypass).
async function sendCallTx(tronWeb, { fromBase58, toBase58, data, value = 0n, multisig = false, feeLimit }) {
  const base = tronWeb.fullNode.host.replace(/\/$/, '');
  const dataHex = typeof data === 'string' && data.startsWith('0x') ? data.slice(2) : data || '';
  // Pass-through (1 wei == 1 sun): see top-of-file unit-model comment.
  // Java-tron's /wallet/triggersmartcontract declares call_value as a
  // Long; we serialize as a Number. Bounded by Long.MAX_VALUE (~9.22e18).
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
      ? ' (impersonation requires the patched TransactionCapsule — rebuild via scripts/build-tre-fork.sh)'
      : '';
    throw new Error(`broadcast failed: ${code}${hint}`);
  }
  return signed.txID || broadcastJson.txid;
}

// Plain TRX transfer (TransferContract) with optional impersonated
// owner_address. Same idea as sendCallTx but for the value-only
// path: builds via /wallet/createtransaction, signs with multisig
// flag (bypasses TronWeb's owner-key check), broadcasts. Used by
// makeImpersonatingSigner.sendTransaction({to, value}) when no
// calldata is present.
async function sendTransferTx(tronWeb, { fromBase58, toBase58, value, multisig = false }) {
  const base = tronWeb.fullNode.host.replace(/\/$/, '');
  // Pass-through (1 wei == 1 sun): see top-of-file unit-model comment.
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
    throw new Error(`broadcast failed: ${broadcastJson.code || broadcastJson.message || JSON.stringify(broadcastJson)}`);
  }
  return signed.txID || broadcastJson.txid;
}

async function rpcCall(tronWeb, method, params = []) {
  const url = tronWeb.fullNode.host.replace(/\/$/, '') + '/tre';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function callOrFalse(tronWeb, method, params = []) {
  const r = await rpcCall(tronWeb, method, params).catch(e => ({
    error: { message: e.message },
  }));
  if (r.error) return { supported: false, reason: r.error.message };
  return { supported: true, result: r.result };
}

const mine = tw => callOrFalse(tw, 'tre_mine', []);
const setBlockTime = (tw, seconds) => callOrFalse(tw, 'tre_blockTime', [seconds]);
const setAccountBalance = (tw, addr, sun) => callOrFalse(tw, 'tre_setAccountBalance', [addr, String(sun)]);
const setAccountCode = (tw, addr, code) => callOrFalse(tw, 'tre_setAccountCode', [addr, code]);
const setAccountStorageAt = (tw, addr, slot, value) => callOrFalse(tw, 'tre_setAccountStorageAt', [addr, slot, value]);
const unlockAccounts = (tw, addrs) => callOrFalse(tw, 'tre_unlockedAccounts', [addrs]);

// State snapshot / revert -- patched-fork only. The fork dumps
// (accountStore, codeStore, contractStore, storageRowStore) into
// an in-memory map keyed by a returned id ("0x1", "0x2", ...).
// Revert restores the dumped state and discards the snapshot id
// and any newer ids (matches Hardhat's evm_revert semantics).
//
// Block number / timestamp are intentionally NOT rolled back -- see
// the comment in plugin/tre-fork/src/.../TreJsonRpcImpl.java. Tests
// can rely on monotonically advancing blocks, but should re-warp
// time after revert if they need a specific timestamp.
const snapshot = tw => callOrFalse(tw, 'tre_snapshot', []);
const revert = (tw, id) => callOrFalse(tw, 'tre_revert', [id]);

// Account impersonation — patched-fork only (see
// plugin/tre-fork/src/org/tron/core/services/jsonrpc/tre/
// TreImpersonationRegistry.java + the validateSignature guard in
// plugin/tre-fork/src/org/tron/core/capsule/TransactionCapsule.java).
//
// Server-side: tre_impersonateAccount adds `addr` to a static whitelist
// consulted by TransactionCapsule.validateSignature. Any tx whose
// owner_address is on the list skips ECRecover + permission/weight
// checks and is accepted regardless of which key signed it.
//
// Client-side: the bridge mirrors the server set in
// `_localImpersonations` so `getSigner(addr)` and `connect(signer)`
// know to route writes through the forging path. The two must stay
// in sync — every successful `tre_impersonateAccount` is followed by a
// `registerLocalImpersonation`, and stop-impersonating drops both.
//
// `callOrFalse` semantics let an UNPATCHED fork (method-not-found)
// fail cleanly with `{ supported: false }`; the bridge degrades to
// the previous no-op behaviour in that case.
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

// Pure instamine mode. tronbox/tre:dev requires blockTime=0 for
// `tre_mine` to work — at any non-zero blockTime, tre_mine raises a
// NullPointerException. The deploy/receipt loops re-mine periodically,
// which closes the "mine raced the mempool" race that earlier images
// avoided by using blockTime=1.
async function enableInstamine(tronWeb, { blockTime = 0 } = {}) {
  const res = await setBlockTime(tronWeb, blockTime);
  if (!res.supported) {
    return { supported: false, reason: res.reason, mode: 'default' };
  }
  await mine(tronWeb).catch(() => {});
  try {
    await tronWeb.trx.getCurrentBlock();
  } catch {
    /* keep ref_block fresh — failure here is non-fatal */
  }
  return { supported: true, mode: 'fast', blockTime };
}

module.exports = {
  rpcCall,
  sendCallTx,
  sendTransferTx,
  WEI_PER_SUN,
  weiToSun,
  valueToCallValue,
  jsonStringifyWithBigInts,
  mine,
  setBlockTime,
  enableInstamine,
  setAccountBalance,
  setAccountCode,
  setAccountStorageAt,
  unlockAccounts,
  snapshot,
  revert,
  impersonateAccount,
  stopImpersonatingAccount,
  registerLocalImpersonation,
  unregisterLocalImpersonation,
  isLocallyImpersonated,
};
