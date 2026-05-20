'use strict';

const path = require('node:path');
const { expect } = require('chai');

const { extendCompileConfig, isActive, DEFAULT_MIRROR } = require('../src/compile/config');
const { resolveSourcePaths } = require('../src/compile/source-resolver');
const { TronCompileError, PLUGIN_NAME } = require('../src/compile/errors');

// Hardhat's extendConfig is called with (resolved, user). We construct
// minimal objects here that hit only the fields the compile module
// actually reads; the rest of Hardhat's surface isn't loaded.
function makeConfigs({ user = {}, solcVersion = '0.8.20' } = {}) {
  const config = {
    solidity: { compilers: [{ version: solcVersion, settings: {} }] },
    paths: { root: '/tmp/project', sources: '/tmp/project/contracts' },
  };
  const userConfig = { ...user };
  return { config, userConfig };
}

describe('compile/errors', function () {
  it('TronCompileError attributes failures to the plugin', function () {
    const err = new TronCompileError('boom');
    expect(err).to.be.an('error');
    expect(err.pluginName).to.equal(PLUGIN_NAME);
    expect(PLUGIN_NAME).to.equal('@openzeppelin/hardhat-tron');
  });
});

describe('compile/config.extendCompileConfig', function () {
  it('applies sensible defaults when tre is omitted entirely', function () {
    const { config, userConfig } = makeConfigs();
    extendCompileConfig(config, userConfig);
    expect(config.tre.compiler).to.deep.include({
      target: 'tron',
      include: [],
      exclude: [],
      separateArtifacts: false,
      mirror: DEFAULT_MIRROR,
      disabled: false,
      versionPragmaOverride: false,
    });
  });

  it('preserves user-supplied compiler options', function () {
    const { config, userConfig } = makeConfigs({
      user: {
        tre: {
          compiler: {
            target: 'tron-when-network-tron',
            include: ['contracts/**/*.sol'],
            exclude: ['contracts/mocks/**'],
            separateArtifacts: true,
            mirror: 'https://example.com',
            disabled: false,
            versionPragmaOverride: true,
            batches: [{ name: '01-utils', dirs: ['contracts/utils'] }],
          },
        },
      },
    });
    extendCompileConfig(config, userConfig);
    expect(config.tre.compiler.target).to.equal('tron-when-network-tron');
    expect(config.tre.compiler.include).to.deep.equal(['contracts/**/*.sol']);
    expect(config.tre.compiler.exclude).to.deep.equal(['contracts/mocks/**']);
    expect(config.tre.compiler.separateArtifacts).to.equal(true);
    expect(config.tre.compiler.mirror).to.equal('https://example.com');
    expect(config.tre.compiler.versionPragmaOverride).to.equal(true);
    expect(config.tre.compiler.batches).to.have.lengthOf(1);
  });

  it('rejects an invalid target with a TronCompileError', function () {
    const { config, userConfig } = makeConfigs({
      user: { tre: { compiler: { target: 'bogus' } } },
    });
    let err;
    try {
      extendCompileConfig(config, userConfig);
    } catch (e) {
      err = e;
    }
    // Note: `HardhatPluginError` flattens subclass constructors, so
    // `err instanceof TronCompileError` is false even though
    // TronCompileError extends it. Identify our errors via
    // `pluginName` instead — that's the contract we own.
    expect(err).to.be.an('error');
    expect(err.pluginName).to.equal(PLUGIN_NAME);
    expect(err.message).to.match(/tre\.compiler\.target must be one of/);
  });

  it('rejects non-array include / exclude', function () {
    {
      const { config, userConfig } = makeConfigs({ user: { tre: { compiler: { include: 'oops' } } } });
      expect(() => extendCompileConfig(config, userConfig)).to.throw(/include must be an array/);
    }
    {
      const { config, userConfig } = makeConfigs({ user: { tre: { compiler: { exclude: [42] } } } });
      expect(() => extendCompileConfig(config, userConfig)).to.throw(/exclude must be an array/);
    }
  });

  it('rejects non-http mirror', function () {
    const { config, userConfig } = makeConfigs({ user: { tre: { compiler: { mirror: 'file:///x' } } } });
    expect(() => extendCompileConfig(config, userConfig)).to.throw(/mirror must be an http/);
  });

  it('rejects activation without configured solc compilers', function () {
    const config = { solidity: { compilers: [] }, paths: {} };
    expect(() => extendCompileConfig(config, {})).to.throw(/no solidity\.compilers entries are configured/);
  });

  it('rejects multi-version solc when target=tron', function () {
    const config = {
      solidity: { compilers: [{ version: '0.8.20' }, { version: '0.8.26' }] },
      paths: {},
    };
    expect(() => extendCompileConfig(config, {})).to.throw(/does not yet support multi-version compiles/);
  });

  it('allows multi-version solc when disabled is true', function () {
    const config = {
      solidity: { compilers: [{ version: '0.8.20' }, { version: '0.8.26' }] },
      paths: {},
    };
    extendCompileConfig(config, { tre: { compiler: { disabled: true } } });
    expect(config.tre.compiler.disabled).to.equal(true);
  });
});

describe('compile/config.isActive', function () {
  function hreWith(treConfig, networkConfig = {}) {
    return {
      config: { tre: { compiler: treConfig } },
      network: { config: networkConfig },
    };
  }

  it('returns true when target=tron', function () {
    expect(isActive(hreWith({ target: 'tron' }))).to.equal(true);
  });

  it('returns false when disabled is true', function () {
    expect(isActive(hreWith({ target: 'tron', disabled: true }))).to.equal(false);
  });

  it('returns false when target is absent (no compiler config)', function () {
    expect(isActive({ config: { tre: {} }, network: { config: {} } })).to.equal(false);
  });

  it('gates target=tron-when-network-tron on network.tron flag', function () {
    expect(isActive(hreWith({ target: 'tron-when-network-tron' }, { tron: true }))).to.equal(true);
    expect(isActive(hreWith({ target: 'tron-when-network-tron' }, { tron: false }))).to.equal(false);
    expect(isActive(hreWith({ target: 'tron-when-network-tron' }, {}))).to.equal(false);
  });
});

describe('compile/source-resolver.resolveSourcePaths', function () {
  // The resolver walks the filesystem and matches globs against
  // project-relative paths. Use the fixture project as a real tree.
  const fixtureRoot = path.join(__dirname, 'fixtures', 'minimal');

  function hreWith(treCompiler) {
    return {
      config: {
        tre: { compiler: treCompiler },
        paths: { root: fixtureRoot, sources: path.join(fixtureRoot, 'contracts') },
      },
      network: { config: {} },
    };
  }

  it('falls through to runSuper when the plugin is inactive', async function () {
    let sentinel = 'super';
    const result = await resolveSourcePaths(
      { sourcePath: path.join(fixtureRoot, 'contracts') },
      hreWith({ disabled: true, include: [], exclude: [] }),
      async () => sentinel,
    );
    expect(result).to.equal('super');
  });

  it('falls through to runSuper when no filters are configured', async function () {
    const result = await resolveSourcePaths(
      { sourcePath: path.join(fixtureRoot, 'contracts') },
      hreWith({ target: 'tron', include: [], exclude: [] }),
      async () => 'super',
    );
    expect(result).to.equal('super');
  });

  it('returns only files matching the include glob', async function () {
    const paths = await resolveSourcePaths(
      { sourcePath: path.join(fixtureRoot, 'contracts') },
      hreWith({ target: 'tron', include: ['contracts/Greeter.sol'], exclude: [] }),
      async () => null,
    );
    expect(paths).to.be.an('array').with.lengthOf(1);
    expect(paths[0]).to.match(/Greeter\.sol$/);
  });

  it('drops files that match the exclude glob', async function () {
    const paths = await resolveSourcePaths(
      { sourcePath: path.join(fixtureRoot, 'contracts') },
      hreWith({ target: 'tron', include: ['contracts/**/*.sol'], exclude: ['contracts/Greeter.sol'] }),
      async () => null,
    );
    expect(paths).to.be.an('array').with.lengthOf(0);
  });
});
