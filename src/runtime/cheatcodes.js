'use strict';

// Wrappers around the patched java-tron image's `tre_*` JSON-RPC
// methods. All cheatcodes live on the `/tre` endpoint — the
// `/jsonrpc` endpoint is the EVM-compat shim and does not expose
// `tre_*`.
//
// This module ships the time/snapshot subset (`mine`, `setBlockTime`,
// `snapshot`, `revert`) plus the account-state mutators
// (`setAccountBalance`, `setAccountCode`, `setAccountStorageAt`,
// `unlockAccounts`). Impersonation cheatcodes layer on later.

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
};
