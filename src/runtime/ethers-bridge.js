// Replaces the network-touching surface of `hre.ethers` with a
// TronWeb-backed equivalent so unmodified tests can run against the
// local TRE container.
//
// This module ships the deploy surface:
//
//   hre.ethers.deployContract(name, args?, signer?)
//     → load the Hardhat artifact, deploy via TronWeb, and return a
//       Contract-shaped facade exposing `target`, `interface`,
//       `deploymentTransaction()`, `waitForDeployment()`, and a
//       method dispatch that routes view calls through
//       `triggerconstantcontract` and state-changing calls through
//       TronWeb's `.send()` path.
//
// hardhat-ethers's own `extendEnvironment` runs first (it's required
// before this plugin in the consuming project's hardhat.config); the
// bridge runs after and overwrites only the parts it needs to
// redirect.
//
// Read-side bridges (`getContractFactory`, `getContractAt`,
// `getSigners`), signer integration, and the loadFixture / snapshot
// stack layer on top of this in subsequent modules.
const path = require('node:path');
const fs = require('node:fs');
const { extendEnvironment } = require('hardhat/config');
const { ethers: ethersV6 } = require('ethers');
const { TronWeb } = require('tronweb');

const signersMod = require('./signers');

// -- Receipt registry + stub provider --------------------------------
//
// Mirror of the behaviour from test/helpers/ethers-facade.js. Stored
// receipts are returned by `getTransactionReceipt(hash)` so chai-
// matchers can resolve their lookups against the cached value.

const knownReceipts = new Map();

// LRU cap on knownReceipts. Every successful tx, every reverted tx,
// every deploy, every sendTransaction lands here forever — unbounded
// growth over a 30-min, 7500-test run accumulates 30k+ entries each
// carrying decoded `logs[]` arrays plus `fragment` references that
// pin Interface objects. By test ~5000 the map alone holds 100+ MB
// and V8 spends real wall time in major GC. The matchers only look
// up by hash within the same describe block's chain (and even that
// is rare past the immediate `tx.wait()` resolution), so an
// insertion-order LRU with a generous window is plenty.
const _KNOWN_RECEIPTS_MAX = 2000;
function rememberReceipt(hash, receipt) {
  knownReceipts.set(hash, receipt);
  if (knownReceipts.size > _KNOWN_RECEIPTS_MAX) {
    // Drop oldest 25% in one pass — keeps amortized cost O(1) instead
    // of trimming one entry per insertion at the limit.
    const dropCount = knownReceipts.size - Math.floor(_KNOWN_RECEIPTS_MAX * 0.75);
    const it = knownReceipts.keys();
    for (let i = 0; i < dropCount; i++) knownReceipts.delete(it.next().value);
  }
}

// Memoize ethers Interface + FunctionFragment per ABI fragment.
// `staticCallWithRevertData`, `sendImpersonatedCall`, and
// `makeMethod`'s tuple-input branch each allocate a fresh
// single-function Interface + FunctionFragment PER CALL. The ABI
// fragment object itself is stable per facade (it lives in the
// artifact's abi[] array), so a WeakMap keyed by the fragment ref
// reuses the parsed objects across all ~30k calls without leaking
// when facades get GC'd.
const _fragmentMemo = new WeakMap();
function getFragmentAndIface(fnAbi) {
  let cached = _fragmentMemo.get(fnAbi);
  if (cached) return cached;
  cached = {
    fragment: ethersV6.FunctionFragment.from(fnAbi),
    iface: new ethersV6.Interface([fnAbi]),
  };
  _fragmentMemo.set(fnAbi, cached);
  return cached;
}

// stubProvider is shared across every facade and signer the bridge
// hands out. The methods below are filled in at hook-time once `hre`
// is available (we need TronWeb to actually query chain state).
// Until then they return sane defaults for tests that probe them at
// load time.
const stubProvider = {
  _hre: null,
  _tw() {
    if (!this._hre) return null;
    return this._hre.tre.makeTronWeb().tronWeb;
  },
  async getTransactionReceipt(hash) {
    return knownReceipts.get(hash) || null;
  },
  async getNetwork() {
    return { chainId: 3360022319n, name: 'tron-tvm' };
  },
  async getCode(address) {
    const tw = this._tw();
    if (!tw) return '0x';
    const addr = signersMod.toBase58(address);
    try {
      const info = await tw.trx.getContract(addr);
      return info && info.bytecode ? '0x' + info.bytecode : '0x';
    } catch {
      return '0x';
    }
  },
  async getBalance(address) {
    const tw = this._tw();
    if (!tw) return 0n;
    const addr = signersMod.toBase58(address);
    const sun = await tw.trx.getBalance(addr).catch(() => 0);
    return BigInt(sun);
  },
  async getBlockNumber() {
    const tw = this._tw();
    if (!tw) return 0;
    return time.latestBlock(tw);
  },
  async getBlock(blockHashOrNumber) {
    const tw = this._tw();
    if (!tw) return null;
    const tag = blockHashOrNumber === 'latest' || blockHashOrNumber == null ? undefined : blockHashOrNumber;
    const block = await (tag === undefined ? tw.trx.getCurrentBlock() : tw.trx.getBlock(tag)).catch(() => null);
    if (!block) return null;
    // Project TVM's `transactions[]` array onto ethers v6's block
    // shape. Each entry has a `txID`; we expose hashes as `0x`-
    // prefixed strings, and synthesize `.getTransaction(idx)` so
    // tests that chain `block.getTransaction(0).then(tx =>
    // provider.getTransactionReceipt(tx.hash))` (e.g.
    // ERC2771Forwarder's `bubbles out of gas` post-revert receipt
    // read) find the right tx via knownReceipts.
    const txs = Array.isArray(block.transactions) ? block.transactions : [];
    const txHashes = txs.map((t) => '0x' + (t.txID || t.txId || ''));
    return {
      number: block.block_header && block.block_header.raw_data.number,
      timestamp: block.block_header && Math.floor(block.block_header.raw_data.timestamp / 1000),
      hash: block.blockID ? '0x' + block.blockID : null,
      transactions: txHashes,
      getTransaction: async (idx) => {
        const hash = txHashes[idx];
        if (!hash) return null;
        return { hash, blockHash: block.blockID ? '0x' + block.blockID : null };
      },
    };
  },
  async estimateGas(tx) {
    // TVM has no `eth_estimateGas` analog, but
    // `/wallet/triggerconstantcontract` returns `energy_used` from a
    // dry-run that mirrors EVM gas semantics under our 1:1
    // gas-to-energy mapping. Used by OZ's ERC2771Forwarder tests'
    // `estimateRequest` helper, which forms a synthetic call from
    // the forwarder to its target with the forwarded calldata + the
    // appended `from` address (ERC-2771 trailing-sender encoding).
    //
    // The TX shape is the ethers v6 transaction-request: `{from, to,
    // data, value, gasLimit}`. We map directly: `to → contract_address`,
    // `from → owner_address`, `data → data` (raw hex calldata).
    const tw = this._tw();
    if (!tw) return 0n;
    const from = signersMod.toBase58(tx.from);
    const to = signersMod.toBase58(tx.to);
    const data = typeof tx.data === 'string' && tx.data.startsWith('0x') ? tx.data.slice(2) : tx.data || '';
    const body = {
      owner_address: TronWeb.address.toHex(from),
      contract_address: TronWeb.address.toHex(to),
      data,
      visible: false,
    };
    const url = tw.fullNode.host.replace(/\/$/, '') + '/wallet/triggerconstantcontract';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .catch(() => null);
    if (!res || (res.result && res.result.code)) {
      // Match ethers' shape on simulation failure — throw with revert
      // data so chai-matchers can match `revertedWith*`. Most callers
      // just want a numeric estimate; if the simulation reverts they
      // typically don't care about the data, only that something was
      // returned without an exception. Default to 21000n on error
      // rather than throwing, mirroring the loose "guess" behavior of
      // EVM clients on simulation failure.
      return 21000n;
    }
    return BigInt(res.energy_used || 21000);
  },
  async getStorage(address, slot) {
    const tw = this._tw();
    if (!tw) return '0x' + '0'.repeat(64);
    const addr = signersMod.toBase58(address);
    const slotHex = typeof slot === 'bigint' ? ethersV6.toBeHex(slot, 32) : slot;
    const rpc = tw.fullNode.host.replace(/\/$/, '') + '/tre';
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'debug_storageRangeAt',
        params: [0, 0, addr, slotHex, 1],
      }),
    })
      .then((r) => r.json())
      .catch(() => null);
    const storage = res && res.result && res.result.storage;
    if (storage) {
      const entry = Object.values(storage)[0];
      if (entry && entry.value) return '0x' + entry.value;
    }
    return '0x' + '0'.repeat(64);
  },
};

// -- Address conversion ---------------------------------------------
//
// Hot-path: every tx response, every event log, every staticCall
// argument round-trips an address through one of these. Each
// conversion does either base58 → hex21 (sha256d checksum verify) or
// hex → EIP-55 (keccak256). Across ~30k txs × multiple addresses each
// these allocations and hashes are non-trivial. We cache the
// string→string mapping in bounded LRU-ish Maps — pure functions, so
// caching is safe; bounded because a long run with many unique
// addresses (CREATE2 spam tests) shouldn't grow memory unbounded.

const _ADDR_CACHE_MAX = 4096;
const _hexCache = new Map(); // key: any-string input → checksummed 0x-hex
const _base58Cache = new Map(); // key: 0x-hex or 41-hex string → T... base58

function _trimCache(m) {
  if (m.size <= _ADDR_CACHE_MAX) return;
  // Map iteration follows insertion order; drop the oldest 25% so we
  // don't trim on every set when at the limit.
  const dropCount = m.size - Math.floor(_ADDR_CACHE_MAX * 0.75);
  const it = m.keys();
  for (let i = 0; i < dropCount; i++) m.delete(it.next().value);
}

// Returns an EIP-55-checksummed 0x-hex address. Tests that compare
// against ethers utilities (`getCreate2Address`, `getAddress`, etc)
// expect the checksummed form, and ethers' string equality is
// case-sensitive — so we always emit checksummed here.
function tronToHex(addr) {
  if (!addr) return addr;
  if (typeof addr !== 'string') {
    let hex;
    const hex21 = TronWeb.address.toHex(addr);
    hex = '0x' + hex21.slice(2);
    return ethersV6.getAddress(hex);
  }
  const cached = _hexCache.get(addr);
  if (cached !== undefined) return cached;
  let hex;
  if (addr.startsWith('0x') && addr.length === 42) {
    hex = addr;
  } else {
    const hex21 = TronWeb.address.toHex(addr);
    hex = '0x' + hex21.slice(2);
  }
  const result = ethersV6.getAddress(hex);
  _hexCache.set(addr, result);
  _trimCache(_hexCache);
  return result;
}

function toTronBase58(addr) {
  // Handle Addressable / Signer / Contract-like objects that callers
  // pass through `ethers.getContractAt(name, contractInstance)` and
  // `factory.attach(otherContract)`. Without this, the object falls
  // through and downstream `TronWeb.address.toHex(obj)` returns '0x',
  // which `ethersV6.getAddress` rejects with "invalid address 0x".
  if (addr && typeof addr === 'object') {
    if (typeof addr.tronAddress === 'string') return addr.tronAddress;
    if (typeof addr.target === 'string') return toTronBase58(addr.target);
    if (typeof addr.address === 'string') return toTronBase58(addr.address);
  }
  if (typeof addr !== 'string') return addr;
  if (addr.startsWith('T') && addr.length === 34) return addr;
  const cached = _base58Cache.get(addr);
  if (cached !== undefined) return cached;
  let result;
  if (addr.startsWith('0x') && addr.length === 42) {
    result = TronWeb.address.fromHex('41' + addr.slice(2));
  } else if (/^41[0-9a-fA-F]{40}$/.test(addr)) {
    result = TronWeb.address.fromHex(addr);
  } else {
    return addr;
  }
  _base58Cache.set(addr, result);
  _trimCache(_base58Cache);
  return result;
}

// Pull a plain address string out of:
//   - a `0x...` / TRON `T...` literal
//   - a signer- or contract-like object with `.address`
//   - an `ethers.Typed` wrapper ({ type, value }) around any of the above
//     — tests use `ethers.Typed.address(signer)` for overload disambiguation
function asAddressString(value) {
  // ethers.Typed wrapper — recurse so nested `Typed.address(signer)` works.
  if (value && typeof value === 'object' && typeof value.type === 'string' && 'value' in value) {
    return asAddressString(value.value);
  }
  // Signer- or Contract-like object with a string `.address` property.
  if (value && typeof value === 'object' && typeof value.address === 'string') {
    return value.address;
  }
  return value;
}

// Detect a trailing tx-options object on a contract-method call. ethers
// v6 accepts these forms:
//   contract.method(arg1, arg2, { value, gasLimit, ... })
//   contract.method(ethers.Typed.foo(arg1), ethers.Typed.overrides({ value }))
// Both must NOT be counted as ABI inputs for overload resolution, and
// `{ value }` needs to be forwarded as msg.value on the resulting tx.
//
// `expectedInputCount` (when known) gates the duck-typed overrides
// detection: we only treat a plain `{value, ...}` object as overrides
// when `args.length === expectedInputCount + 1`. Otherwise it's a
// struct argument that happens to share field names with tx options
// (e.g. ForwardRequest = {from, to, value, gas, deadline, data,
// signature}) — stripping it would break encoding. When the count is
// unknown (overload picker), we ONLY accept the explicit
// `ethers.Typed.overrides(...)` form, never duck-typed.
//
// Returns { overrides, args } where `args` excludes the trailing
// options (if any). overrides defaults to `{}`.
function splitOverrides(args, expectedInputCount = null) {
  if (args.length === 0) return { overrides: {}, args };
  const last = args[args.length - 1];
  if (last && typeof last === 'object') {
    // Typed.overrides → ethers.Typed wrapper whose `type` is 'overrides'.
    // Always honoured regardless of expectedInputCount because the
    // wrapper is unambiguous.
    if (typeof last.type === 'string' && '_typedSymbol' in last && last.type === 'overrides') {
      return { overrides: last.value || {}, args: args.slice(0, -1) };
    }
    // Plain duck-typed overrides — only safe to strip when we KNOW
    // the input count and the trailing arg is the extra one.
    if (expectedInputCount != null && args.length === expectedInputCount + 1 && !('_typedSymbol' in last)) {
      const overrideKeys = ['value', 'gasLimit', 'gasPrice', 'nonce', 'from', 'maxFeePerGas', 'maxPriorityFeePerGas'];
      if (overrideKeys.some((k) => k in last)) {
        return { overrides: last, args: args.slice(0, -1) };
      }
    }
  }
  return { overrides: {}, args };
}

// `nested` flag distinguishes TOP-LEVEL args (which go to TronWeb's
// contract proxy directly — TronWeb expects base58) from STRUCT-NESTED
// args (which TronWeb internally re-encodes via its bundled ethers
// AbiCoder — ethers wants hex, and chokes on base58 with "cannot
// encode object for signature with missing names").
//
// Concretely: in `forwarder.executeBatch(requests)` where requests is
// `ForwardRequestData[]`, top-level `requests` goes through TronWeb
// (which fans out to ethers for each struct). The struct fields
// `from`/`to` must be 0x-hex; the top-level call still takes base58
// from the bridge's perspective (it never enters TronWeb's address
// argument path — only the struct fields do).
function normalizeArg(value, input, nested = false) {
  if (!input) return value;
  // ethers.Typed wrapper — unwrap before any other normalization so
  // `ethers.Typed.bytes('0x...')` / `ethers.Typed.string('...')` etc.
  // flow through the regular path. Tests use Typed.* for overload
  // disambiguation and the value field carries the actual payload.
  if (value && typeof value === 'object' && typeof value.type === 'string' && '_typedSymbol' in value) {
    return normalizeArg(value.value, input, nested);
  }
  if (input.type === 'address') {
    if (nested) {
      // Hex for TronWeb's struct-internal ABI encoding (which uses
      // bundled ethers; ethers AbiCoder rejects T... base58).
      const s = asAddressString(value);
      if (typeof s === 'string' && s.startsWith('T') && s.length === 34) {
        return '0x' + TronWeb.address.toHex(s).slice(2);
      }
      return s;
    }
    return toTronBase58(asAddressString(value));
  }
  if (input.type === 'address[]') {
    if (!Array.isArray(value)) return value;
    if (nested) {
      return value.map((v) => {
        const s = asAddressString(v);
        if (typeof s === 'string' && s.startsWith('T') && s.length === 34) {
          return '0x' + TronWeb.address.toHex(s).slice(2);
        }
        return s;
      });
    }
    return value.map((v) => toTronBase58(asAddressString(v)));
  }
  // Tuple / struct — recurse into components. Anything inside a tuple
  // is `nested` from TronWeb's perspective. Accept both object form
  // (`{target, value, data}`) and tuple form (`[target, value, data]`).
  if (input.type === 'tuple' && Array.isArray(input.components)) {
    if (Array.isArray(value)) {
      return value.map((v, i) => normalizeArg(v, input.components[i], true));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const comp of input.components) {
        if (comp.name && comp.name in value) {
          out[comp.name] = normalizeArg(value[comp.name], comp, true);
        }
      }
      return out;
    }
  }
  // Tuple-array — `tuple[]` or `tuple[N]`. Map each element through
  // the tuple component types.
  if (/^tuple\[/.test(input.type) && Array.isArray(input.components)) {
    if (!Array.isArray(value)) return value;
    const inner = { type: 'tuple', components: input.components };
    return value.map((v) => normalizeArg(v, inner, true));
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function decodeOne(value, output) {
  if (value === null || value === undefined) return value;
  // Struct-typed return: ABI exposes `{type: 'tuple', components: [...]}`.
  // TronWeb returns the tuple as an array of component values. We
  // mirror ethers v6's Result by mapping each component through
  // decodeOne and attaching named accessors when components have names
  // (so `result._key` / `result._value` work alongside `result[0]` /
  // `result[1]`). chai's `.deep.equal([a, b])` still passes because
  // the underlying object IS an array.
  if (output && output.type === 'tuple' && Array.isArray(output.components)) {
    if (!Array.isArray(value)) return value;
    // TronWeb has a quirk: when a function's SINGLE output is a named
    // struct (e.g. `Checkpoints.at(...) returns (Checkpoint memory ret)`)
    // it wraps the struct values in an extra single-element array —
    // `[[key, value]]` instead of `[key, value]`. Without unwrapping
    // we hand `[key, value]` to decodeOne for component[0] (a scalar
    // uint), which falls through to `BigInt(arr.toString())` =
    // `BigInt("2,17")` and throws. Detect by: outer-array has exactly
    // 1 element, and that element's array length matches the tuple
    // component count.
    let v = value;
    if (
      output.components.length > 1 &&
      v.length === 1 &&
      Array.isArray(v[0]) &&
      v[0].length === output.components.length
    ) {
      v = v[0];
    }
    const decoded = v.map((vi, i) => decodeOne(vi, output.components[i]));
    for (let i = 0; i < output.components.length; i++) {
      const name = output.components[i] && output.components[i].name;
      if (name && !(name in decoded)) {
        Object.defineProperty(decoded, name, { value: decoded[i], enumerable: false });
      }
    }
    return decoded;
  }
  if (output && output.type === 'address') {
    // ethers v6 returns EIP-55-checksummed addresses; tests compare with
    // strict equality against `ethers.getCreate2Address(...)` etc which
    // also returns checksummed. tronToHex returns lowercase, so route
    // through ethers.getAddress to apply the checksum.
    return ethersV6.getAddress(tronToHex(value));
  }
  if (output && /^address\[/.test(output.type)) {
    return Array.isArray(value) ? value.map((v) => ethersV6.getAddress(tronToHex(v))) : value;
  }
  // Generic array types (uint256[], bytes32[], etc). TronWeb sometimes
  // returns the scalar "0" for an empty dynamic array instead of `[]` —
  // normalize to a real array so callers' `.length` / `.map` work.
  if (output && /\[/.test(output.type)) {
    if (!Array.isArray(value)) return value === '0' || value == null ? [] : [value];
    const innerType = output.type.replace(/\[[^\]]*\]$/, '');
    return value.map((v) => decodeOne(v, { type: innerType }));
  }
  if (output && /^uint|^int/.test(output.type)) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(value);
    if (typeof value === 'string') return BigInt(value);
    // Reject arrays from the toString fallback — `Array.prototype.
    // toString()` joins with `,`, and `BigInt("2,17")` throws. This
    // happens when an unwrapped tuple sneaks through (e.g. the
    // Checkpoints quirk above). Pass through unchanged so the caller
    // sees a useful assertion error instead of a SyntaxError.
    if (value && !Array.isArray(value) && typeof value.toString === 'function') {
      return BigInt(value.toString());
    }
  }
  return value;
}

function decodeReturn(value, outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) return value;
  if (outputs.length === 1) {
    // Special-case: single output of type tuple should be decoded as
    // a tuple (array of component values), NOT unwrapped. TronWeb
    // returns it already as an array, so pass straight through.
    if (outputs[0].type === 'tuple') {
      return decodeOne(value, outputs[0]);
    }
    // TronWeb wraps NAMED single returns in a single-element array
    // (e.g. `returns (address ret0)` → `["41ab..."]`); unnamed
    // single returns come back as a scalar. Unwrap so decodeOne
    // sees the same value either way.
    const v = Array.isArray(value) ? value[0] : value;
    return decodeOne(v, outputs[0]);
  }
  // Multi-output: ethers v6 returns a Result that supports BOTH
  // positional (`result[0]`) AND named (`result.fields`) access.
  // TronWeb returns a plain array. Build a Result-shaped value by
  // attaching named properties for each output that has a `name` in
  // the ABI, while keeping array semantics intact.
  const decoded = Array.isArray(value) ? value.map((v, i) => decodeOne(v, outputs[i])) : value;
  if (Array.isArray(decoded)) {
    for (let i = 0; i < outputs.length; i++) {
      const name = outputs[i] && outputs[i].name;
      if (name && !(name in decoded)) {
        Object.defineProperty(decoded, name, { value: decoded[i], enumerable: false });
      }
    }
  }
  return decoded;
}

// -- Receipt translation --------------------------------------------

// `iface` is an ethers v6 Interface for the contract that emitted the
// logs - used to decode each log into `{fragment, args}` so upstream
// OZ tests can do `receipt.logs.find(e => e.fragment.name === 'X')`
// and `event.args[0]`. If a log's topic0 isn't in `iface` (e.g. logs
// from a different contract called during the tx), the log is left
// without a fragment but still has raw topics/data.
function translateReceipt(txId, info, iface = null) {
  // Total TVM fee = energy_fee + net_fee (both sun). Used by the
  // ether-balance chai matcher to back out gas cost from the
  // sender's notional balance change. info.fee is the precomputed
  // sum when populated.
  const energyFee =
    info && info.receipt && Number.isFinite(info.receipt.energy_fee) ? Number(info.receipt.energy_fee) : 0;
  const netFee = info && info.receipt && Number.isFinite(info.receipt.net_fee) ? Number(info.receipt.net_fee) : 0;
  const feeSun = info && info.fee != null ? Number(info.fee) : energyFee + netFee;
  // TVM tracks energy (≈ EVM gas) separately from sun-denominated
  // fees. Expose `energy_usage_total` as `gasUsed` so OZ tests that
  // probe gas-meter semantics — e.g. ERC2771Forwarder's `bubbles out
  // of gas` (asserts `gasUsed == gasLimit` after an inner OOG burns
  // all remaining energy via `invalid()`) — see a value with the same
  // units they expect on EVM. java-tron's `INVALID` handler routes
  // through `Program.spendAllEnergy()`, so on a full-burn the
  // receipt reports `energy_usage_total == feeLimit / energy_price`;
  // the bridge maps `gasLimit → feeLimit = gasLimit * 100`, so the
  // ratio inverts cleanly back to gasLimit.
  const energyUsed =
    info && info.receipt && Number.isFinite(info.receipt.energy_usage_total)
      ? BigInt(info.receipt.energy_usage_total)
      : 0n;
  return {
    hash: '0x' + txId,
    transactionHash: '0x' + txId,
    status: info && info.receipt && info.receipt.result === 'SUCCESS' ? 1 : 0,
    blockNumber: info ? info.blockNumber : undefined,
    gasUsed: energyUsed,
    cumulativeGasUsed: energyUsed,
    // chai-matchers' canonical changeEtherBalance does a
    // `provider.send("eth_getBlockByHash", [blockHash, false])`
    // probe; we don't serve that, and the upstream-style matcher is
    // replaced by the TVM-aware chai matchers module. blockHash is exposed
    // for tests that read it directly. java-tron's `blockHash` is
    // not on the unconfirmed-info shape, so this is best-effort.
    blockHash:
      info && info.blockHash ? (info.blockHash.startsWith('0x') ? info.blockHash : '0x' + info.blockHash) : undefined,
    // Fee in sun. Stored under `feeSun` (not `gasUsed * gasPrice`)
    // because TVM accounts for energy + bandwidth separately and the
    // direct sun figure is what the FullNode reports.
    feeSun,
    logs: ((info && info.log) || []).map((l, i) => {
      const log = {
        address: l.address ? '0x' + l.address : undefined,
        topics: (l.topics || []).map((t) => (t.startsWith('0x') ? t : '0x' + t)),
        data: l.data ? (l.data.startsWith('0x') ? l.data : '0x' + l.data) : '0x',
        logIndex: i,
        index: i, // ethers v6 alias
        transactionHash: '0x' + txId,
        blockNumber: info ? info.blockNumber : undefined,
        removed: false,
      };
      if (iface) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed) {
            log.fragment = parsed.fragment;
            log.args = parsed.args;
            log.eventName = parsed.name;
            log.eventSignature = parsed.signature;
          }
        } catch {
          /* log emitted by another contract or unknown topic — leave undecorated */
        }
      }
      return log;
    }),
    // Pass through internal value-transfer descriptors for the TVM
    // ether-balance matcher. Shape: see tronweb/src/types/Trx.ts —
    // each entry has caller_address (21-byte hex with 41 prefix),
    // transferTo_address, callValueInfo[] with sun callValue, and
    // rejected flag (true = inner CALL reverted, skip).
    internalTransactions: (info && info.internal_transactions) || [],
    contractAddress: info ? info.contract_address : undefined,
  };
}

function buildRevertError(txId, info) {
  const result = info && info.receipt && info.receipt.result;
  const raw = info && info.contractResult && info.contractResult[0] ? info.contractResult[0] : '';
  const data = raw ? '0x' + raw : '0x';
  let reason = null;
  if (data.startsWith('0x08c379a0')) {
    try {
      reason = ethersV6.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0];
    } catch {
      /* leave reason null */
    }
  }
  const msg = reason
    ? `transaction reverted with reason: ${reason}`
    : `transaction reverted (result=${result || 'unknown'}, data=${data})`;
  const err = new Error(msg);
  err.data = data;
  err.reason = reason;
  err.txHash = '0x' + txId;
  err.receipt = translateReceipt(txId, info);
  // Stash the failed-tx receipt so tests that follow the chai
  // rejection with a separate `provider.getTransactionReceipt(hash)`
  // probe (e.g. ERC2771Forwarder's `bubbles out of gas` reads
  // `gasUsed` from a receipt-fetch AFTER asserting the rejection)
  // can still find the receipt. Without this, the chain has the tx
  // (it was mined; only execution reverted), but the bridge's
  // `stubProvider.getTransactionReceipt` cache misses.
  rememberReceipt('0x' + txId, err.receipt);
  return err;
}

// -- Method invocation ----------------------------------------------

// View-call path that preserves revert data. TronWeb's high-level
// Canonical Solidity function-signature serialization. The naive
// `inputs.map(i => i.type).join(',')` collapses tuple-typed inputs to
// the literal string `"tuple"`, which is what TronWeb's
// `function_selector` rejects with "OTHER_ERROR" or the call
// silently reverts with `data=0x` — TVM resolves selectors by hashing
// the canonical signature, and `verify(tuple)` hashes to a different
// 4-byte than the actual on-chain `verify((address,address,...))`.
//
// Used by:
//   * `function_selector` body of /wallet/triggerconstantcontract
//   * /wallet/triggersmartcontract (impersonated + non-impersonated)
//   * overload bookkeeping in `overloadsByName`
function canonicalType(input) {
  if (input.type === 'tuple' && Array.isArray(input.components)) {
    return `(${input.components.map(canonicalType).join(',')})`;
  }
  const m = input.type && input.type.match(/^tuple(\[[^\]]*\])$/);
  if (m && Array.isArray(input.components)) {
    return `(${input.components.map(canonicalType).join(',')})${m[1]}`;
  }
  return input.type;
}
function canonicalSig(fnAbi) {
  return `${fnAbi.name}(${fnAbi.inputs.map(canonicalType).join(',')})`;
}

// `triggerConstantContract` throws `Error("REVERT opcode executed")`
// and STRIPS all `constant_result` from the error — chai-matchers
// can't match `revertedWithCustomError` against an error with no
// `.data`. We bypass TronWeb's wrapper and POST to the underlying
// `/wallet/triggerconstantcontract` HTTP endpoint directly, where the
// response always contains `constant_result` (whether the call
// succeeded or reverted).
async function staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized) {
  const { fragment: ifaceFragment, iface } = getFragmentAndIface(fnAbi);
  const sig = canonicalSig(fnAbi);

  // Encode args via ethers (handles addresses, tuples, dynamic types
  // correctly) — then strip the 4-byte selector to get just the
  // parameter bytes that triggerconstantcontract expects.
  const calldata = iface.encodeFunctionData(
    ifaceFragment,
    normalized.map((v, i) => coerceForEthers(v, fnAbi.inputs[i])),
  );
  const parameter = calldata.slice(10); // strip 0x + selector

  // Owner-address override for impersonated callers — view calls
  // honor `msg.sender` checks (e.g. AccessManaged.canCall predicates)
  // against the override even though `triggerconstantcontract` doesn't
  // verify the owner's signature. Falls back to the TronWeb's default
  // address when no override is set.
  const ownerBase58 = tronWeb._impersonatedFrom || tronWeb.defaultAddress.base58;
  const url = tronWeb.fullNode.host.replace(/\/$/, '') + '/wallet/triggerconstantcontract';
  const body = {
    owner_address: TronWeb.address.toHex(ownerBase58),
    contract_address: TronWeb.address.toHex(tronContract.address),
    function_selector: sig,
    parameter,
    visible: false,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await resp.json();

  // Successful call: result.result === true (only field) AND no
  // contract_result code. On revert, `result.code` is set and
  // `constant_result[0]` holds the revert bytes.
  const reverted = res.result && (res.result.code || res.result.message);
  const raw = res.constant_result && res.constant_result[0] ? '0x' + res.constant_result[0] : '0x';

  if (!reverted) {
    if (raw === '0x' && fnAbi.outputs.length === 0) return undefined;
    const decoded = iface.decodeFunctionResult(ifaceFragment, raw);
    return decodeReturn(decoded, fnAbi.outputs);
  }

  const err = new Error(`call reverted (data=${raw})`);
  err.data = raw;
  if (raw.startsWith('0x08c379a0')) {
    try {
      err.reason = ethersV6.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + raw.slice(10))[0];
    } catch {
      /* */
    }
  }
  throw err;
}

// ethers Interface encoders expect 0x-hex addresses, not Tron base58.
// Our `normalizeArg` had converted addresses to base58 for TronWeb's
// flow - undo that for the ethers encoder.
//
// Mirror normalizeArg's tuple/tuple[] recursion: ForwardRequest in
// ERC2771Forwarder.verify(...) is a `tuple` whose `from` and `to`
// fields are addresses; without recursing, the base58 strings flow
// through to ethers' AbiCoder which throws "cannot encode object for
// signature with missing names (argument='values')". Same shape for
// any struct with embedded address fields.
function coerceForEthers(value, input) {
  if (!input) return value;
  if (input.type === 'address') {
    if (typeof value === 'string' && value.startsWith('T') && value.length === 34) {
      return '0x' + TronWeb.address.toHex(value).slice(2);
    }
    return value;
  }
  if (input.type === 'address[]' && Array.isArray(value)) {
    return value.map((v) => coerceForEthers(v, { type: 'address' }));
  }
  if (input.type === 'tuple' && Array.isArray(input.components)) {
    if (Array.isArray(value)) {
      return value.map((v, i) => coerceForEthers(v, input.components[i]));
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const comp of input.components) {
        if (comp.name && comp.name in value) {
          out[comp.name] = coerceForEthers(value[comp.name], comp);
        }
      }
      return out;
    }
  }
  if (/^tuple\[/.test(input.type) && Array.isArray(input.components) && Array.isArray(value)) {
    const inner = { type: 'tuple', components: input.components };
    return value.map((v) => coerceForEthers(v, inner));
  }
  return value;
}

// State-changing call from an impersonated owner_address.
//
// TronWeb's `contract().method().send()` hardwires `owner_address`
// to its TronWeb's default address, so to make `msg.sender` reflect
// the impersonated address we bypass the high-level path entirely:
//
//   1. encode calldata via ethers
//   2. POST /wallet/triggersmartcontract with `owner_address = imp`
//   3. sign the returned unsigned tx with the deployer's key (we
//      don't have `imp`'s key — that's the whole point)
//   4. POST /wallet/broadcasttransaction
//
// The patched fork's TransactionCapsule.validateSignature sees that
// owner_address is on TreImpersonationRegistry and skips ECRecover,
// accepting the tx despite the signature ECRecovering to the
// deployer.
async function buildRevertErrorWithSim(txId, info, fnAbi, tronContract, tronWeb, normalized) {
  const err = buildRevertError(txId, info);
  if (err.data && err.data !== '0x') return err;
  try {
    await staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized);
  } catch (simErr) {
    if (simErr && typeof simErr.data === 'string' && simErr.data !== '0x') {
      err.data = simErr.data;
      if (simErr.reason) err.reason = simErr.reason;
    }
  }
  return err;
}

function makeMethod(fnAbi, tronContract, tronWeb, hre) {
  const isView = fnAbi.stateMutability === 'view' || fnAbi.stateMutability === 'pure';

  async function invoke(...rawArgs) {
    // Strip the trailing tx-options object (`{value, gasLimit, ...}`
    // or `ethers.Typed.overrides({...})`) before normalizing — it's
    // not an ABI input. Passing the ABI input count gates the
    // duck-typed detection so struct args like ForwardRequest
    // (which has `from`, `value`, …) aren't misclassified.
    const { overrides, args } = splitOverrides(rawArgs, fnAbi.inputs.length);
    const normalized = args.map((a, i) => normalizeArg(a, fnAbi.inputs[i]));
    if (isView) {
      // Use the low-level path: gives us revert data for
      // chai-matchers' `revertedWithCustomError`, and decodes tuples
      // (Checkpoint structs, eip712Domain etc) via ethers v6's
      // Interface so destructure-by-name and array-index access both
      // work. Falls back to TronWeb's high-level decoder if a fragment
      // resolution issue surfaces.
      try {
        return await staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized);
      } catch (e) {
        // Re-throw revert errors directly so chai-matchers sees `.data`.
        if (e && typeof e.data === 'string') throw e;
        // Other errors: fall through to the legacy decoder path so we
        // don't lose tests that pass today.
        const raw = await tronContract[fnAbi.name](...normalized).call();
        return decodeReturn(raw, fnAbi.outputs);
      }
    }
    // Honor `overrides.gasLimit` by mapping to TVM's `feeLimit` via
    // TRE's energy price (~100 sun/energy — see the feeLimit comment
    // below). Without this, a test passing `{gasLimit: 100_000}` to
    // force an OOG sub-call path silently ran with the full 1B-sun
    // budget and the constrained-gas scenario was never exercised
    // (e.g. test/governance/TimelockController.test.js's
    // mockFunctionOutOfGas case, test/utils/Address.test.js's
    // $functionCall(..., {gasLimit: 120_000n}) case).
    const _gasLimitSun =
      overrides.gasLimit != null
        ? Math.max(1, Math.min(1_000_000_000, Number(BigInt(overrides.gasLimit)) * 100))
        : 1_000_000_000;
    // feeLimit caps the energy a single tx can buy. TRE's hard
    // ceiling is 1_000_000_000 sun (1000 TRX) — TronWeb's validator
    // rejects anything higher with "feeLimit must be >= 0 and <=
    // 1000000000". At TRE's energy price of ~100 sun/energy, that
    // converts to a 10M-energy budget, which matches the
    // `originEnergyLimit` cap. We set the max here so heavier calls
    // (e.g. Create2 deploy of full VestingWallet bytecode) get the
    // full budget. Tests that still exhaust 10M surface a real TVM
    // ceiling — see test 4 in Create2.test.js.
    const sendOpts = { feeLimit: _gasLimitSun };
    if (overrides.value != null) {
      // 1 wei == 1 sun pass-through (cheatcodes.js top-of-file).
      // TronWeb's contract proxy expects `callValue` in sun. It also
      // JSON.stringify's the params internally, so BigInts need to be
      // converted to strings (Java parses Long natively from quoted
      // ints in this field). Number coercion would lose precision
      // above 2^53 sun.
      const { valueToCallValue } = require('./cheatcodes');
      const cv = valueToCallValue(overrides.value);
      sendOpts.callValue = typeof cv === 'bigint' ? cv.toString() : cv;
    }

    let txId;
    try {
      txId = await tronContract[fnAbi.name](...normalized).send(sendOpts);
    } catch (sendErr) {
      // TronWeb throws synchronously on tx failure modes that never
      // produce a tx hash — out-of-energy, validation failures, etc.
      // Tests using `revertedWithCustomError` (e.g. Clones'
      // `revert if address already used` → FailedDeployment, Create2's
      // `fails deploying into existent address`) expect a real revert
      // error with `.data`. Re-simulate via `triggerconstantcontract`,
      // which carries the revert payload even when the broadcast path
      // OOG'd, and re-throw as a proper revert error.
      const msg = sendErr && sendErr.message ? String(sendErr.message) : String(sendErr);
      if (/Not enough energy|OUT_OF_ENERGY|REVERT/.test(msg)) {
        try {
          await staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized);
        } catch (simErr) {
          if (simErr && typeof simErr.data === 'string') throw simErr;
        }
      }
      throw sendErr;
    }
    const info = await hre.tre.waitForReceipt(tronWeb, txId);
    if (!(info && info.receipt && info.receipt.result === 'SUCCESS')) {
      throw await buildRevertErrorWithSim(txId, info, fnAbi, tronContract, tronWeb, normalized);
    }
    return makeTxResponse(txId, info, tronContract._iface || null, {
      fromBase58: tronWeb.defaultAddress && tronWeb.defaultAddress.base58,
      toBase58: tronContract.address,
      callValueSun: sendOpts.callValue || 0,
    });
  }

  // ethers v6 exposes `contract.fn.estimateGas(...)` and chai-matchers
  // uses it to check whether a view-style call will revert (the gas
  // estimate fails for reverts). We synthesize the same surface by
  // routing through the same static-call path as `invoke` (which now
  // returns proper revert data), and returning a constant gas estimate
  // when the call succeeds. Tests check `.estimateGas` for the
  // success/revert *outcome*, not a precise gas number, so a sentinel
  // suffices.
  invoke.estimateGas = async (...args) => {
    const normalized = args.map((a, i) => normalizeArg(a, fnAbi.inputs[i]));
    if (isView) {
      // re-uses the revert-extracting static-call path → throws with
      // `.data` on revert
      await staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized);
      return 21000n;
    }
    // For non-view, simulate via triggerConstantContract too — the
    // chain will execute and revert/succeed without actually
    // committing. Gas number is a fabricated constant.
    await staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized);
    return 50000n;
  };

  invoke.staticCall = async (...rawArgs) => {
    // Strip trailing overrides — chai-matchers pass `{blockTag, value,
    // ...}` here too. blockTag is a no-op on TVM (no historical
    // state) so we just ignore it.
    const { args } = splitOverrides(rawArgs, fnAbi.inputs.length);
    const normalized = args.map((a, i) => normalizeArg(a, fnAbi.inputs[i]));
    // TronWeb's `tronContract.method(...).call()` refuses to invoke
    // any method with `stateMutability === 'payable'` ("Methods with
    // state mutability \"payable\" must use send()"). For payable
    // methods we route through `/wallet/triggerconstantcontract`
    // directly — that endpoint accepts payable methods AND surfaces
    // revert data via `constant_result` for chai-matchers' revert
    // assertions.
    //
    // For non-payable non-view methods, we stick with TronWeb's
    // `.call()` path: it correctly simulates CREATE / CREATE2 inner
    // calls (returning the predicted address as the call's output),
    // whereas triggerconstantcontract on a function that internally
    // CREATEs returns empty `constant_result`. The Clones tests rely
    // on `factory.$clone.staticCall(impl)` returning the would-be
    // clone address — without this fallback they all break.
    const isPayable = fnAbi.stateMutability === 'payable';
    if (isPayable) {
      try {
        return await staticCallWithRevertData(fnAbi, tronContract, tronWeb, normalized);
      } catch (e) {
        if (e && typeof e.data === 'string') throw e;
        throw e;
      }
    }
    const raw = await tronContract[fnAbi.name](...normalized).call();
    return decodeReturn(raw, fnAbi.outputs);
  };
  invoke.fragment = fnAbi;
  // ethers v6 contract methods expose `.getFragment(...args)` for
  // overload resolution. Used by upstream OZ tests via
  // `this.target.fnRestricted.getFragment().selector` to grab the
  // 4-byte selector without re-encoding. We return the same ABI
  // descriptor we hand back via `.fragment`, wrapped in
  // ethers.FunctionFragment so `.selector` / `.format()` work.
  invoke.getFragment = () => getFragmentAndIface(fnAbi).fragment;
  return invoke;
}

function makeTxResponse(txId, info, iface = null, meta = {}) {
  const receipt = translateReceipt(txId, info, iface);
  rememberReceipt('0x' + txId, receipt);
  // Outer-call metadata so the TVM-aware chai matchers (plugin/
  // chai-matchers-tvm.js) can account for the user→contract value
  // flow alongside receipt.internalTransactions. `meta.fromBase58`,
  // `meta.toBase58`, and `meta.callValueSun` are passed by
  // makeMethod/invoke; we project them onto the ethers-shaped
  // `{from, to, valueSun}` properties.
  const from = meta.fromBase58 ? tronToHex(meta.fromBase58) : undefined;
  const to = meta.toBase58 ? tronToHex(meta.toBase58) : undefined;
  const valueSun = meta.callValueSun != null ? Number(meta.callValueSun) : 0;
  return {
    hash: '0x' + txId,
    transactionHash: '0x' + txId,
    txId,
    blockNumber: info ? info.blockNumber : undefined,
    from,
    to,
    valueSun,
    feeSun: receipt.feeSun,
    internalTransactions: receipt.internalTransactions,
    logs: receipt.logs,
    wait: async () => receipt,
  };
}

// -- Contract facade -----------------------------------------------

// `tronWeb` here is the signer's TronWeb (its bytecode signs txs).
// For read-only paths the deployer's TronWeb works just as well, but
// `factory.connect(signer)` rebuilds the facade with the SIGNER's
// TronWeb so writes are signed by them.
function makeFacade(abi, tronAddress, tronWeb, hre, deploymentTx = null) {
  // Group functions by name (a list of overloads per name) AND by
  // full signature. When the test calls `factory.$computeAddress(...)`
  // with 2 args, we look at the overload list and pick the one whose
  // input count matches; with 3 args we pick the 3-arg variant.
  // Tests that disambiguate explicitly via `factory['name(type,type)']`
  // hit the signature map directly.
  const overloadsByName = new Map();
  const fnsBySignature = new Map();
  // Selector → ABI function. OZ tests use
  // `target.connect(signer)[selector]()` (where `selector` is a
  // 4-byte hex string like `'0xabcd1234'`) to call functions by
  // selector without re-encoding. Index up front so the Proxy's
  // string-key fallthrough can find the match.
  const fnsBySelector = new Map();
  for (const item of abi) {
    if (item.type !== 'function') continue;
    const sig = canonicalSig(item);
    fnsBySignature.set(sig, item);
    if (!overloadsByName.has(item.name)) overloadsByName.set(item.name, []);
    overloadsByName.get(item.name).push(item);
    const selector = ethersV6.FunctionFragment.from(item).selector.toLowerCase();
    fnsBySelector.set(selector, item);
  }

  const tronContract = tronWeb.contract(abi, tronAddress);
  const ethersInterface = new ethersV6.Interface(abi);
  // Stash the iface on the TronWeb contract so makeMethod can pull
  // it into translateReceipt without re-allocating per call.
  tronContract._iface = ethersInterface;

  // Look up an ABI function by signature, accepting either the
  // canonical form (`$slice(address[],uint256)`) or the named-parameter
  // form (`$slice(address[] arr, uint256 start)`). Upstream OZ tests
  // (Arrays.test.js et al.) use the named form to dispatch through
  // `this.mock[fragment](...)` — without this, the Proxy returns
  // undefined and the test fails with "is not a function". We parse
  // via ethers.FunctionFragment so param-name handling matches what
  // ethers v6's own `Interface.getFunction` does.
  function lookupBySignature(prop) {
    const direct = fnsBySignature.get(prop);
    if (direct) return direct;
    try {
      const frag = ethersV6.FunctionFragment.from(prop);
      const canonical = `${frag.name}(${frag.inputs.map((i) => i.type).join(',')})`;
      return fnsBySignature.get(canonical) || null;
    } catch {
      return null;
    }
  }

  // Build a method handle for a SPECIFIC ABI entry. For overloaded
  // names TronWeb's contract proxy can't disambiguate by signature —
  // it picks one entry under the shared name and the encoder errors
  // with "too many arguments" on the others (seen in
  // test/token/ERC20/extensions/ERC1363.test.js via
  // `getFunction('transferAndCall(address,uint256,bytes)')(...)`).
  // For overloaded names, build a single-function TronWeb contract
  // so TronWeb sees exactly the right entry. Single-entry names
  // reuse the shared `tronContract` to avoid per-method allocations.
  //
  // Both the single-fn TronWeb contracts AND the resulting method
  // handles are cached per facade. Without this, every property
  // access through the Proxy's `get` trap allocated a fresh
  // single-fn contract + fresh `invoke`/`staticCall`/`estimateGas`
  // closures, even when the same `contract.balanceOf` was looked
  // up dozens of times in a loop. The cache lives in this closure
  // so it's GC'd with the facade.
  const _singleContractCache = new Map(); // canonicalSig → single TronWeb contract
  const _methodHandleCache = new Map(); // canonicalSig → invoke fn
  function methodFor(fn) {
    const sig = canonicalSig(fn);
    const cachedHandle = _methodHandleCache.get(sig);
    if (cachedHandle) return cachedHandle;
    const overloads = overloadsByName.get(fn.name);
    let contractForCall;
    if (overloads && overloads.length > 1) {
      let single = _singleContractCache.get(sig);
      if (!single) {
        single = tronWeb.contract([fn], tronAddress);
        single._iface = ethersInterface;
        _singleContractCache.set(sig, single);
      }
      contractForCall = single;
    } else {
      contractForCall = tronContract;
    }
    const handle = makeMethod(fn, contractForCall, tronWeb, hre);
    _methodHandleCache.set(sig, handle);
    return handle;
  }
  // Checksummed (EIP-55) for ethers-style assertions like
  // `ethers.getCreate2Address(factory.target, ...)` which ethers also
  // returns in checksummed form.
  const hexAddress = ethersV6.getAddress(tronToHex(tronAddress));

  const target = {
    target: hexAddress,
    address: hexAddress,
    tronAddress,
    interface: ethersInterface,
    abi,
    // Runner mirrors ethers v6's `BoundContract.runner` — it's the
    // signer-shaped object that subsequent `.connect(...)` calls
    // accept. Carrying the closure's `tronWeb` here lets chained
    // patterns work: `token.connect(governor.runner).transfer(...)`
    // (used by test/helpers/governance.js's `delegate` to send the
    // token transfer from whoever the governor was connected to).
    // Without `tronWeb` on the runner, those connects fall back to
    // the deployer key and the transfer reverts with
    // ERC20InsufficientBalance(deployer, 0, expected) — see Governor
    // Storage / TimelockControl fixtures.
    runner: { provider: stubProvider, tronWeb },
    provider: stubProvider,
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'getAddress') return async () => hexAddress;
      if (prop === 'getFunction') {
        // ethers v6 API: contract.getFunction('name(type,type)') returns
        // a method handle for an exact-signature lookup. Used by tests
        // that disambiguate overloads explicitly. For bare names with
        // multiple overloads, return the same arg-shape dispatcher the
        // `contract.name(...)` proxy path uses — ethers v6 lets you
        // call `getFunction('name')(...args)` and resolves the overload
        // at call time via `ethers.Typed.X(...)` wrappers, identical to
        // accessing the method directly. SignatureChecker.test.js's
        // ERC1271/ERC7913 cases exercise this:
        //   `mock.getFunction('$isValidSignatureNow')(Typed.address(...), ...)`
        // and
        //   `mock.getFunction('$isValidSignatureNow')(Typed.bytes(...), ...)`
        // both target the same name but different `bytes`/`address` first
        // argument types.
        return (signature) => {
          if (typeof signature === 'string' && signature.includes('(')) {
            const fn = lookupBySignature(signature);
            if (fn) return methodFor(fn);
          }
          const overloads = overloadsByName.get(signature);
          if (overloads && overloads.length === 1) {
            return methodFor(overloads[0]);
          }
          if (overloads && overloads.length > 1) {
            return makeOverloadDispatcher(overloads, tronAddress, tronWeb, hre, ethersInterface);
          }
          throw new Error(`getFunction: no match for "${signature}"`);
        };
      }
      if (prop === 'connect') {
        // contract.connect(signer) → rebuild the facade routed
        // through the signer's TronWeb so subsequent state-changing
        // calls are signed by that signer's key.
        return (signer) => {
          if (signer && signer.tronWeb) {
            return makeFacade(abi, tronAddress, signer.tronWeb, hre);
          }
          return makeFacade(abi, tronAddress, tronWeb, hre);
        };
      }
      if (prop === 'attach') {
        return (addr) => makeFacade(abi, toTronBase58(addr), tronWeb, hre);
      }
      if (prop === 'waitForDeployment') {
        return async () => target;
      }
      if (prop === 'deploymentTransaction') {
        // chai-matchers' `.to.emit(contract, ...)` against a
        // `contract.deploymentTransaction()` destructures `{hash}`
        // and awaits `.wait()` to scan logs for the expected event.
        // Synthesize a TransactionResponse from the deploy receipt
        // when we have one; null is only acceptable when nothing
        // was deployed (e.g. an `attach`).
        return () => deploymentTx || null;
      }
      if (prop === 'then' || typeof prop === 'symbol') return undefined;

      // Selector lookup: `contract[selector]()` where selector is a
      // 4-byte hex string. Used by upstream OZ tests that grab the
      // selector via `fnRestricted.getFragment().selector` and call
      // by that without re-binding to the function name.
      if (typeof prop === 'string' && /^0x[0-9a-fA-F]{8}$/.test(prop)) {
        const fn = fnsBySelector.get(prop.toLowerCase());
        if (fn) return methodFor(fn);
      }

      // Match on full signature first (for explicit disambiguation),
      // then fall back to name-with-overload-by-arity dispatch.
      // `lookupBySignature` accepts both the canonical form
      // `name(type,type)` and the named-parameter form
      // `name(type name1, type name2)` — Arrays.test.js dispatches
      // through `this.mock['$slice(address[] arr, uint256 start)']`.
      if (typeof prop === 'string' && prop.includes('(')) {
        const fn = lookupBySignature(prop);
        if (fn) return methodFor(fn);
      }
      const overloads = overloadsByName.get(prop);
      if (!overloads || overloads.length === 0) return undefined;
      if (overloads.length === 1) {
        return methodFor(overloads[0]);
      }
      // Multiple overloads — return a dispatcher that picks by arg
      // count at call time. This is what ethers v6's Contract Proxy
      // does for overloaded methods.
      return makeOverloadDispatcher(overloads, tronAddress, tronWeb, hre, ethersInterface);
    },
  });
}

function makeOverloadDispatcher(overloads, tronAddress, tronWeb, hre, ethersInterface) {
  // TronWeb's `contract(abi, addr)` proxy can't disambiguate
  // overloaded function names — `contract.method` returns one entry
  // (typically the first registered), and calling with a different
  // arg count fails inside its ABI encoder ("invalid address" /
  // "invalid bytes" / etc on whatever the missing arg's type is).
  //
  // Sidestep that by building a single-function TronWeb contract per
  // overload: TronWeb sees exactly one entry under this name, so it
  // can't pick the wrong one. The single-fn contract + method handle
  // are cached per (dispatcher, signature) so repeat calls into the
  // same overload don't reallocate. Cache scope is this closure so
  // it's GC'd with the dispatcher (one dispatcher per facade per
  // overloaded name).
  const _dispatchSingleCache = new Map();
  const _dispatchHandleCache = new Map();
  function handleFor(fn) {
    const sig = canonicalSig(fn);
    const cached = _dispatchHandleCache.get(sig);
    if (cached) return cached;
    let single = _dispatchSingleCache.get(sig);
    if (!single) {
      single = tronWeb.contract([fn], tronAddress);
      if (ethersInterface) single._iface = ethersInterface;
      _dispatchSingleCache.set(sig, single);
    }
    const handle = makeMethod(fn, single, tronWeb, hre);
    _dispatchHandleCache.set(sig, handle);
    return handle;
  }

  function pickOverload(rawArgs) {
    // ethers v6 accepts an optional trailing tx-options object —
    // don't count it as an ABI input when picking the overload. The
    // unwrapped args (without overrides) are also what makeMethod
    // will normalize, so we forward them in the same shape.
    const { args } = splitOverrides(rawArgs);
    const candidates = overloads.filter((o) => o.inputs.length === args.length);
    if (candidates.length === 0) {
      throw new Error(
        `No overload of \`${overloads[0].name}\` matches argument count ${args.length}. ` +
          `Available: ${overloads.map((o) => `(${o.inputs.map((i) => i.type).join(',')})`).join(', ')}`,
      );
    }
    if (candidates.length === 1) return candidates[0];
    // Same-arity overloads — use `ethers.Typed.X(value)` wrappers to
    // disambiguate. Each Typed value carries `.type` (e.g. 'bytes32'
    // vs 'bytes'); score each candidate by how many of its input
    // types match the corresponding Typed hint. Required for
    // test/utils/cryptography/RSA.test.js which calls
    // `$pkcs1Sha256(Typed.bytes32(digest), sig, exp, mod)` vs
    // `$pkcs1Sha256(Typed.bytes(data), sig, exp, mod)` — both 4-arg.
    const scored = candidates.map((o) => {
      let score = 0;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a && typeof a === 'object' && '_typedSymbol' in a && typeof a.type === 'string') {
          if (a.type === o.inputs[i].type) score += 2;
          else score -= 1;
        }
      }
      return { o, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].o;
  }

  async function invoke(...args) {
    const match = pickOverload(args);
    return handleFor(match)(...args);
  }
  invoke.staticCall = async (...args) => {
    const match = pickOverload(args);
    return handleFor(match).staticCall(...args);
  };
  return invoke;
}

// -- Artifact loader ------------------------------------------------

// Each test re-deploys via `ethers.deployContract(name)`, but the
// artifact JSON itself doesn't change during a test run. Cache by
// name (both bare and fully-qualified) to avoid the directory walk +
// JSON.parse on every fixture call. Memo on `npm test` cleared.
//
// _artifactIndex maps bare names (e.g. "ERC20Mock") → array of
// candidate absolute paths. Built once on first cache-miss bare-name
// lookup by a single `readdirSync({ recursive: true })`. The original
// implementation re-walked the whole `artifacts-tron/contracts` tree
// on every cache-miss — fine for the first N unique contracts but
// wasted ~50-200ms per cold lookup × hundreds of unique contracts on
// the OZ tree.
const _artifactCache = new Map();
let _artifactIndex = null;

function _buildArtifactIndex(root) {
  const idx = new Map();
  if (!fs.existsSync(root)) return idx;
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    if (typeof entry !== 'string') continue;
    if (!entry.endsWith('.json')) continue;
    // Skip Hardhat's `dbg.json` debug-info files; only `<Contract>.json`
    // is a real artifact.
    if (entry.endsWith('.dbg.json')) continue;
    const base = path.basename(entry, '.json');
    const abs = path.join(root, entry);
    let bucket = idx.get(base);
    if (!bucket) {
      bucket = [];
      idx.set(base, bucket);
    }
    bucket.push(abs);
  }
  return idx;
}

function loadArtifact(hre, name) {
  const cached = _artifactCache.get(name);
  if (cached) return cached;

  const artifactsDir = hre.config.paths.artifacts;
  const sep = name.indexOf(':');
  // Fully-qualified `path/to/Foo.sol:Foo` → direct lookup.
  if (sep !== -1) {
    const relPath = name.slice(0, sep);
    const contractName = name.slice(sep + 1);
    const abs = path.join(artifactsDir, relPath, `${contractName}.json`);
    if (!fs.existsSync(abs)) throw new Error(`Artifact not found at ${abs}`);
    const a = JSON.parse(fs.readFileSync(abs, 'utf8'));
    _artifactCache.set(name, a);
    return a;
  }
  // Bare name lookup via prebuilt name → paths index. Both originals
  // (`Foo.json`) and `hardhat-exposed`-generated wrappers (`$Foo.json`)
  // live under the same tree because `exposed.outDir =
  // 'contracts/exposed'` in hardhat.config.cjs.
  const root = path.join(artifactsDir, 'contracts');
  if (!_artifactIndex) _artifactIndex = _buildArtifactIndex(root);
  const candidates = _artifactIndex.get(name);
  if (!candidates || candidates.length === 0) {
    // Possible cause: artifact written AFTER the index was built (rare
    // in test flows — compile runs before test). Rebuild once and retry
    // before giving up.
    _artifactIndex = _buildArtifactIndex(root);
    const retry = _artifactIndex.get(name);
    if (!retry || retry.length === 0) {
      throw new Error(`Artifact for contract "${name}" not found in ${root}`);
    }
    if (retry.length > 1) {
      throw new Error(
        `Multiple artifacts named "${name}" found, please use a fully-qualified name:\n  ${retry.join('\n  ')}`,
      );
    }
    const a = JSON.parse(fs.readFileSync(retry[0], 'utf8'));
    _artifactCache.set(name, a);
    return a;
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple artifacts named "${name}" found, please use a fully-qualified name:\n  ${candidates.join('\n  ')}`,
    );
  }
  const a = JSON.parse(fs.readFileSync(candidates[0], 'utf8'));
  _artifactCache.set(name, a);
  return a;
}

// -- Predict-address cache ---------------------------------------
//
// TVM derives a CREATE'd contract's address as
// `0x41 || keccak256(txID || ownerAddress)[12:]`. The txID depends on
// the full raw_data (selector + args + ref_block_* + expiration +
// timestamp), so it cannot be computed from `nonce` alone the way the
// EVM formula does. Upstream OZ tests pre-compute the address via
// `ethers.getCreateAddress({from, nonce})` — broken on TVM in two
// places (wrong formula AND `getNonce()` is meaningless).
//
// The fix: `signer.predictAddress(name, args, opts)` on the bridge's
// signer object builds + signs a CreateSmartContract tx via
// TronWeb (which populates `tx.contract_address` locally before
// broadcast — see node_modules/tronweb/lib/esm/lib/TransactionBuilder/
// helper.js:37-43). The pre-signed tx is stashed here keyed by
// `(deployerBase58, name, serializedArgs)`; the next
// `ethers.deployContract(name, args, signer)` call with matching key
// pops the cache and broadcasts the pre-signed tx byte-for-byte, so
// the deployed address matches the prediction.
//
// Cache lifetime: each cache hit consumes the entry (one prediction →
// one broadcast). Stale entries that are never consumed leak memory
// of the order of one signed tx per stale predict, which is
// negligible for the test suite.
const _prebuildCache = new Map();

function prebuildCacheKey(deployerBase58, name, args) {
  // BigInt + address/struct args round-trip through JSON via a tagged
  // sentinel — same approach as the cheatcode module's BigInt-aware
  // stringifier. We don't need to send this to TVM, just a stable
  // string for Map keying, so the simpler form suffices.
  const stringify = (v) => {
    if (typeof v === 'bigint') return 'BI:' + v.toString();
    if (v && typeof v === 'object' && typeof v.target === 'string') return 'T:' + toTronBase58(v.target);
    if (v && typeof v === 'object' && typeof v.address === 'string') return 'A:' + toTronBase58(v.address);
    if (Array.isArray(v)) return '[' + v.map(stringify).join(',') + ']';
    if (typeof v === 'string') return 'S:' + v;
    if (typeof v === 'object' && v !== null) {
      // Stable key order for object args.
      const keys = Object.keys(v).sort();
      return '{' + keys.map((k) => k + '=' + stringify(v[k])).join(',') + '}';
    }
    return String(v);
  };
  return deployerBase58 + '|' + name + '|' + stringify(args);
}

// -- Deploy -------------------------------------------------------

async function deployViaFacade(hre, name, args = [], signer = null) {
  // If a signer is provided, deploy through THAT signer's TronWeb -
  // contract ownership / msg.sender at construction reflects the
  // signer's TVM address. Without a signer, fall back to the
  // default deployer key from hardhat.config.cjs.
  const tronWeb = signer && signer.tronWeb ? signer.tronWeb : hre.tre.makeTronWeb().tronWeb;
  const deployerAddress = signer && signer.tronAddress ? signer.tronAddress : hre.tre.makeTronWeb().address;
  const artifact = loadArtifact(hre, name);
  const ctor = artifact.abi.find((a) => a.type === 'constructor');
  const ctorInputCount = ctor ? ctor.inputs.length : 0;

  // Predict-address shortcut: if a prior `signer.predictAddress(name,
  // args)` call stashed a pre-signed tx for this (deployer, name, args)
  // triple, broadcast it directly. Skipping the createSmartContract
  // rebuild guarantees the deployed address equals the earlier
  // prediction, since the unsigned raw_data (and therefore the txID
  // that feeds into the CREATE formula) is byte-identical.
  const cacheKey = prebuildCacheKey(deployerAddress, name, args);
  const cached = _prebuildCache.get(cacheKey);
  if (cached) {
    _prebuildCache.delete(cacheKey);
    const { address, txId, info } = await hre.tre.submitPrebuilt(tronWeb, cached.signedTx);
    const iface = new ethersV6.Interface(artifact.abi);
    const deployReceipt = translateReceipt(txId, info, iface);
    rememberReceipt('0x' + txId, deployReceipt);
    const deploymentTx = {
      hash: '0x' + txId,
      transactionHash: '0x' + txId,
      blockNumber: info ? info.blockNumber : undefined,
      logs: deployReceipt.logs,
      wait: async () => deployReceipt,
    };
    return makeFacade(artifact.abi, address, tronWeb, hre, deploymentTx);
  }

  // ethers v6 `factory.deploy(...args, overrides)` allows an optional
  // trailing tx-options object carrying `{value, gasLimit, ...}`. Split
  // it out — passing it through as a constructor arg either lands in
  // TronWeb's encoder as garbage or silently disappears (the ctor
  // typically has fewer inputs than args.length), leaving `value`
  // unforwarded. BeaconProxy.test.js's "payable initialization" hits
  // this: the test deploys with `{value: 100n}` and asserts the proxy
  // ended up with 100 sun balance — without the split, value never
  // reached `createSmartContract`.
  const { overrides, args: ctorArgs } = splitOverrides(args, ctorInputCount);

  let parameters;
  if (ctorArgs.length > 0) {
    if (!ctor) {
      throw new Error(`${name} has no constructor but ${ctorArgs.length} arg(s) were passed`);
    }
    // TronWeb's `transactionBuilder.createSmartContract` takes
    // `parameters` as a flat array of VALUES (types are taken from the
    // ABI constructor inputs). The `{type, value}` wrapper format used
    // by `triggerSmartContract` does NOT apply here - passing it
    // through fails inside TronWeb's encoder with "invalid string
    // value". Normalize each arg (address → base58, bigint →
    // decimal string, ethers.Typed → unwrap) and pass raw.
    parameters = ctor.inputs.map((input, i) => normalizeArg(ctorArgs[i], input));
  }

  // 1 wei == 1 sun pass-through on the JS↔TVM boundary. For
  // value-bearing deploys (`factory.deploy(..., {value: 100n})`),
  // forward `value` to TronWeb's `createSmartContract` as `callValue`.
  // BeaconProxy's payable-init test (and similar in ERC1967/UUPS) rely
  // on this — value sent during construction is what funds the proxy.
  const deployOpts = { parameters };
  if (overrides.value != null) {
    const { valueToCallValue } = require('./cheatcodes');
    // TronWeb's `transactionBuilder.createSmartContract` JSON.stringify's
    // its params internally and chokes on BigInt — convert to a
    // decimal string here. Deploy values in the OZ test surface stay
    // well under 2^53 (proxy initialization is ~1e5 sun) so the round
    // trip through string→Number on the Java side is fine.
    const cv = valueToCallValue(overrides.value);
    deployOpts.callValue = typeof cv === 'bigint' ? cv.toString() : cv;
  }
  if (overrides.gasLimit != null) {
    // Same `gasLimit → feeLimit` mapping as makeMethod.invoke: TRE's
    // energy price is ~100 sun/energy, clamped to the [1, 1e9 sun]
    // range java-tron accepts.
    deployOpts.feeLimit = Math.max(1, Math.min(1_000_000_000, Number(BigInt(overrides.gasLimit)) * 100));
  }

  const { address, txId, info } = await hre.tre.deployContract(tronWeb, deployerAddress, artifact, deployOpts);

  // Build a TransactionResponse for `contract.deploymentTransaction()`.
  // `translateReceipt` decodes logs against the deployed contract's
  // ABI so events emitted from the constructor (`AuthorityUpdated`,
  // `Initialized`, …) are visible to chai-matchers' `.to.emit`.
  const iface = new ethersV6.Interface(artifact.abi);
  const deployReceipt = translateReceipt(txId, info, iface);
  rememberReceipt('0x' + txId, deployReceipt);
  const deploymentTx = {
    hash: '0x' + txId,
    transactionHash: '0x' + txId,
    blockNumber: info ? info.blockNumber : undefined,
    logs: deployReceipt.logs,
    wait: async () => deployReceipt,
  };

  return makeFacade(artifact.abi, address, tronWeb, hre, deploymentTx);
}

// -- Factory ------------------------------------------------------

function makeFactory(hre, name, boundSigner = null) {
  const artifact = loadArtifact(hre, name);
  const iface = new ethersV6.Interface(artifact.abi);
  return {
    bytecode: artifact.bytecode,
    interface: iface,
    abi: artifact.abi,
    deploy: async (...args) => deployViaFacade(hre, name, args, boundSigner),
    // factory.connect(signer) returns a new factory whose .deploy
    // routes through the signer's TronWeb. Upstream OZ tests use this
    // to "deploy as alice" patterns.
    connect: (signer) => makeFactory(hre, name, signer),
    attach: (addr) => {
      const tronWeb = boundSigner && boundSigner.tronWeb ? boundSigner.tronWeb : hre.tre.makeTronWeb().tronWeb;
      return makeFacade(artifact.abi, toTronBase58(addr), tronWeb, hre);
    },
    // ethers v6 occasionally probes `getDeployTransaction` to encode
    // constructor args. We synthesize a minimal shape — `data` is the
    // bytecode + abi-encoded args, which is what tests inspect.
    getDeployTransaction: (...args) => {
      const ctor = artifact.abi.find((a) => a.type === 'constructor');
      const encoded = ctor ? iface.encodeDeploy(args) : '0x';
      return { data: ethersV6.concat([artifact.bytecode, encoded]) };
    },
  };
}

extendEnvironment((hre) => {
  if (!(hre.network && hre.network.config && hre.network.config.tron)) return;
  // Give the stubProvider a handle to hre so its lazy methods
  // (getCode/getBalance/getStorage/getBlockNumber) can build TronWeb.
  stubProvider._hre = hre;
  if (!hre.ethers) return;

  // `args` is positional in tests (`deployContract(name, [a,b])`)
  // and sometimes followed by a signer
  // (`deployContract(name, [a,b], signer)`). The 3rd arg can also be
  // a plain `{value, gasLimit, …}` overrides object (proxy tests pass
  // `{value}` here to fund construction). Detect and route into the
  // args list as a trailing overrides element so
  // `deployViaFacade → splitOverrides` forwards it to `callValue`.
  hre.ethers.deployContract = (name, args = [], signerOrOpts = null) => {
    if (signerOrOpts && typeof signerOrOpts === 'object' && !signerOrOpts.tronWeb) {
      const overrideKeys = ['value', 'gasLimit', 'gasPrice', 'nonce', 'from', 'maxFeePerGas', 'maxPriorityFeePerGas'];
      if (overrideKeys.some((k) => k in signerOrOpts)) {
        return deployViaFacade(hre, name, [...(args || []), signerOrOpts], null);
      }
    }
    return deployViaFacade(hre, name, args, signerOrOpts);
  };

  // Chai matchers' `reverted` matcher hits
  // `hre.ethers.provider.getTransactionReceipt` directly. Wire that
  // through the local receipt cache so matchers resolve against the
  // value the deploy / tx path already stored.
  if (hre.ethers.provider) {
    const original = hre.ethers.provider.getTransactionReceipt
      ? hre.ethers.provider.getTransactionReceipt.bind(hre.ethers.provider)
      : null;
    hre.ethers.provider.getTransactionReceipt = async function (hash) {
      const cached = knownReceipts.get(hash);
      if (cached) return cached;
      if (original) {
        try {
          return await original(hash);
        } catch {
          return null;
        }
      }
      return null;
    };
  }
});

module.exports = {
  // Surfaced for `src/runtime/deploy.js` so its constructor-revert
  // path can throw an ethers-shaped error with `.data` for chai
  // matchers' `revertedWithCustomError`. Lazy-required from deploy.js
  // to break a load-order cycle with the bridge.
  buildRevertError,
};
