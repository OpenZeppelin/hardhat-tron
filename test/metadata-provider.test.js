'use strict';

// Regression coverage for two review findings on the hardhat_metadata hook
// (PR #33):
//
// 1. `hardhat_metadata` must work on a keyless network. The genesis-derived
//    instance id is read over plain JSON-RPC (`eth_getBlockByNumber`), which
//    needs no private key — it must not route through a TronWeb client, whose
//    construction throws when the network has no `accounts` configured.
//
// 2. Only a local TRE answers `hardhat_metadata`. `tron: true` marks every
//    TVM network — nile/shasta/mainnet included — and any provider that
//    answers `hardhat_metadata` makes upgrades-core write its deployment
//    manifest to os.tmpdir() instead of the durable `.openzeppelin/` dir.
//    On a non-local network the method must be forwarded untouched.
//
// No docker gating: the wrapped provider is stubbed, which is exactly the
// point — the keyless path never leaves JSON-RPC.

const { expect } = require('chai');

// metadata-provider registers an `extendProvider` hook at require time, which
// needs a live HardhatContext. Stub `hardhat/config` just long enough to load
// the class, then restore the cache and evict metadata-provider from it, so
// the e2e suite's later `require('hardhat')` loads the real module and
// re-registers the hook inside a genuine config-loading context.
const Module = require('node:module');
const hardhatConfigPath = require.resolve('hardhat/config');
const metadataProviderPath = require.resolve('../src/runtime/metadata-provider');
const realHardhatConfig = require.cache[hardhatConfigPath];
const stub = new Module(hardhatConfigPath);
stub.filename = hardhatConfigPath;
stub.loaded = true;
stub.exports = { extendProvider: () => {} };
require.cache[hardhatConfigPath] = stub;
const { TronMetadataProvider } = require(metadataProviderPath);
if (realHardhatConfig) {
  require.cache[hardhatConfigPath] = realHardhatConfig;
} else {
  delete require.cache[hardhatConfigPath];
}
delete require.cache[metadataProviderPath];

const instanceIds = require('../src/runtime/instance-id');
const lifecycle = require('../src/tre/lifecycle');

const GENESIS_HASH = '0x0000000000000000c93baa76a4a508f798a96f59156d9eb17ecede8ec845df2f';

// A wrapped provider stub that answers only the two key-free RPC methods the
// metadata path is allowed to use. Anything else — hardhat_metadata included —
// counts as a forwarded call.
function stubProvider(calls) {
  return {
    async request(args) {
      calls.push(args.method);
      if (args.method === 'eth_chainId') return '0xcd8690dc';
      if (args.method === 'eth_getBlockByNumber') {
        return { number: '0x0', hash: GENESIS_HASH };
      }
      const err = new Error(`the method ${args.method} does not exist/is not available`);
      err.code = -32601;
      throw err;
    },
  };
}

describe('TronMetadataProvider', function () {
  afterEach(function () {
    instanceIds._clearCache();
  });

  it('answers hardhat_metadata on a loopback network without any private key', async function () {
    const calls = [];
    const provider = new TronMetadataProvider(stubProvider(calls), 'tre', 'http://127.0.0.1:9090/jsonrpc');

    const md = await provider.request({ method: 'hardhat_metadata', params: [] });

    expect(md.chainId).to.equal(0xcd8690dc);
    expect(md.instanceId).to.equal(GENESIS_HASH);
    expect(md.forkedNetwork).to.equal(undefined);
    // The whole exchange stays on key-free JSON-RPC: no TronWeb client was
    // needed, so no method beyond the two allowed ones reached the node.
    expect(calls).to.have.members(['eth_chainId', 'eth_getBlockByNumber']);
  });

  it('forwards hardhat_metadata untouched on a non-local tron network', async function () {
    const calls = [];
    const provider = new TronMetadataProvider(stubProvider(calls), 'nile', 'https://nile.trongrid.io/jsonrpc');

    let error;
    try {
      await provider.request({ method: 'hardhat_metadata', params: [] });
    } catch (e) {
      error = e;
    }

    // The node's own method-not-found answer surfaces, so upgrades-core
    // classifies the network as non-dev and keeps the manifest in
    // `.openzeppelin/`.
    expect(calls).to.deep.equal(['hardhat_metadata']);
    expect(error).to.be.an('error');
    expect(error.message).to.contain('does not exist');
  });

  it('still proxies unrelated methods on a local network', async function () {
    const calls = [];
    const provider = new TronMetadataProvider(stubProvider(calls), 'tre', 'http://127.0.0.1:9090/jsonrpc');
    const chainHex = await provider.request({ method: 'eth_chainId', params: [] });
    expect(chainHex).to.equal('0xcd8690dc');
    expect(calls).to.deep.equal(['eth_chainId']);
  });
});

describe('lifecycle.isLocalTre', function () {
  it('treats loopback urls as local', function () {
    expect(lifecycle.isLocalTre('http://127.0.0.1:9090/jsonrpc')).to.equal(true);
    expect(lifecycle.isLocalTre('http://localhost:9090/jsonrpc')).to.equal(true);
    expect(lifecycle.isLocalTre('http://[::1]:9090/jsonrpc')).to.equal(true);
  });

  it('treats public hosts as non-local', function () {
    expect(lifecycle.isLocalTre('https://nile.trongrid.io/jsonrpc')).to.equal(false);
    expect(lifecycle.isLocalTre('https://api.trongrid.io/jsonrpc')).to.equal(false);
  });

  it('treats an unparseable url as non-local', function () {
    expect(lifecycle.isLocalTre('not a url')).to.equal(false);
  });
});
