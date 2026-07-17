'use strict';

// `extendProvider` hook that answers `hardhat_metadata` on tron-typed networks.
//
// Tooling built for the Hardhat Network — notably @openzeppelin/upgrades-core —
// probes a development node's identity through the `hardhat_metadata` (and
// `anvil_metadata`) JSON-RPC method to decide how to key its per-instance
// deployment manifests. A TRE node speaks JSON-RPC but does not implement that
// method, so without this hook upgrades-core treats a TRE as an unknown network
// and keys manifests by chain id alone. Because a restarted TRE keeps its chain
// id, records from a previous instance then leak into the next one; and because
// upgrades-core resolves the manifest through its OWN internal calls (not just
// through this plugin), a plugin-side override cannot fully redirect it.
//
// Answering `hardhat_metadata` here — at the provider every caller shares —
// makes upgrades-core key TRE manifests by chain id AND instance id natively,
// so its internal deployment/kind lookups and any plugin-side reads resolve the
// same instance-qualified manifest. The returned shape mirrors the built-in
// Hardhat Network's response; the instance id is this plugin's stable per-boot
// identifier (see runtime/instance-id.js). Only tron-typed networks are
// wrapped; every other network's provider is returned untouched.

const { extendProvider } = require('hardhat/config');
const { ProviderWrapper } = require('hardhat/internal/core/providers/wrapper');

const instanceIds = require('./instance-id');

class TronMetadataProvider extends ProviderWrapper {
  constructor(wrappedProvider, networkName, networkConfig) {
    super(wrappedProvider);
    this._networkName = networkName;
    this._networkConfig = networkConfig;
  }

  async request(args) {
    if (args && args.method === 'hardhat_metadata') {
      return this._metadata();
    }
    return this._wrappedProvider.request(args);
  }

  async _metadata() {
    // Read the chain id from the node itself so the reported chainId always
    // matches eth_chainId — upgrades-core asserts that invariant.
    const chainHex = await this._wrappedProvider.request({ method: 'eth_chainId', params: [] });
    const chainId = parseInt(String(chainHex).replace(/^0x/, ''), 16);
    const hreShim = { network: { name: this._networkName, config: this._networkConfig } };
    const instanceId = await instanceIds.instanceId(hreShim);
    return {
      clientVersion: 'hardhat-tron',
      chainId,
      instanceId,
      forkedNetwork: undefined,
    };
  }
}

extendProvider(async (provider, config, networkName) => {
  const networkConfig = config.networks[networkName];
  if (!networkConfig || networkConfig.tron !== true) {
    return provider;
  }
  return new TronMetadataProvider(provider, networkName, networkConfig);
});

module.exports = { TronMetadataProvider };
