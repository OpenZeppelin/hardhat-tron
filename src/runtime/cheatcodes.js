'use strict';

// Wrappers around the patched java-tron image's `tre_*` JSON-RPC
// methods. All cheatcodes live on the `/tre` endpoint — the
// `/jsonrpc` endpoint is the EVM-compat shim and does not expose
// `tre_*`.
//
// This module ships only the time/snapshot subset (`mine`,
// `setBlockTime`, `snapshot`, `revert`); account-state and
// impersonation cheatcodes layer on later modules and contracts.

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

module.exports = {
  rpcCall,
  callOrFalse,
  mine,
  setBlockTime,
  snapshot,
  revert,
};
