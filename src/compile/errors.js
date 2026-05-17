//
// plugin/compile/errors.js
//
// One typed error class for everything the compile module can fail at.
// HardhatPluginError lets Hardhat render a friendly message instead of
// a raw stack, attributes the failure to a named plugin in the output,
// and gives us a stable type that callers can switch on if they want
// to.
//
// We deliberately namespace the plugin string ('@openzeppelin/hardhat-tron')
// here rather than importing from a top-level constants file -- the compile
// module owns its own error surface and shouldn't reach upward for naming.
//

const { HardhatPluginError } = require('hardhat/plugins');

const PLUGIN_NAME = '@openzeppelin/hardhat-tron';

class TronCompileError extends HardhatPluginError {
  constructor(message, parentError) {
    super(PLUGIN_NAME, message, parentError);
  }
}

module.exports = { TronCompileError, PLUGIN_NAME };
