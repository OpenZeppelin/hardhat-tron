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
// identifier (see runtime/instance-id.js).
//
// Only a LOCAL TRE answers the method. `tron: true` marks every TVM network —
// nile/shasta/mainnet included — and upgrades-core stores the manifest of any
// network that answers `hardhat_metadata` under os.tmpdir() instead of the
// durable `.openzeppelin/` directory. Answering on a public network would
// therefore send a real deployment history to a transient temp dir. Locality
// is decided per request (plugin-launched container or loopback url — see
// lifecycle.isLocalTre); on a non-local network the call is forwarded
// untouched, so the node's own method-not-found error surfaces and
// upgrades-core keeps its normal chain-id-keyed manifest. The whole exchange
// uses key-free JSON-RPC, so a keyless read-only network config works too.

const { extendProvider } = require('hardhat/config');
const { ProviderWrapper } = require('hardhat/internal/core/providers/wrapper');

const instanceIds = require('./instance-id');
const lifecycle = require('../tre/lifecycle');

class TronMetadataProvider extends ProviderWrapper {
  constructor(wrappedProvider, networkName, url) {
    super(wrappedProvider);
    this._networkName = networkName;
    this._url = url;
  }

  async request(args) {
    if (args && args.method === 'hardhat_metadata' && lifecycle.isLocalTre(this._url)) {
      return this._metadata();
    }
    return this._wrappedProvider.request(args);
  }

  async _metadata() {
    // Read the chain id from the node itself so the reported chainId always
    // matches eth_chainId — upgrades-core asserts that invariant.
    const chainHex = await this._wrappedProvider.request({ method: 'eth_chainId', params: [] });
    const chainId = parseInt(String(chainHex).replace(/^0x/, ''), 16);
    const instanceId = await instanceIds.instanceId({
      networkName: this._networkName,
      url: this._url,
      provider: this._wrappedProvider,
    });
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
  return new TronMetadataProvider(provider, networkName, networkConfig.url);
});

module.exports = { TronMetadataProvider };
