'use strict';

// `extendConfig` hook for the `tre.*` block surfaces unrelated to
// compilation. The compile module owns `tre.compiler.*`; this file
// owns the rest:
//
//   tre.autoStart     boolean   default: true
//   tre.image         string    default: 'tronbox/tre:dev'
//   tre.jarPath       string?   optional bind-mount for the patched FullNode.jar
//   tre.containerName string?   override the auto-generated container name
//   tre.port          number    default: 9090 (host side; matches tronbox/tre's exposed port)
//   tre.keepRunning   boolean   default: false  (skip teardown after the wrapped task)
//   tre.readinessTimeoutMs  number  default: 60000
//   tre.startupEnv    object?   additional `-e KEY=value` env vars passed to docker run
//
// The autoStart wrapper only acts when the configured network has
// `tron: true` AND nothing is already listening on `network.<n>.url`.
//

const { extendConfig } = require('hardhat/config');

const DEFAULTS = {
  autoStart: true,
  // The umbrella `autoStart` switches the whole feature on/off. The
  // per-task gates below let consumers tune which Hardhat tasks
  // actually spawn a container -- tests need TRE, compile does not,
  // node usually does. All three default to the most-common
  // expectation; flip individual ones to false to opt out of a
  // particular task's auto-spawn.
  autoStartOnTest: true,
  autoStartOnCompile: false,
  autoStartOnNode: true,
  image: 'tronbox/tre:dev',
  jarPath: null,
  containerName: null,
  port: 9090,
  keepRunning: false,
  readinessTimeoutMs: 60_000,
  startupEnv: {},
};

extendConfig((config, userConfig) => {
  const userTre = userConfig.tre || {};
  config.tre = config.tre || {};
  // compile/config.js already populated `config.tre.compiler`. Don't
  // overwrite it; just fill in the lifecycle keys.
  for (const k of Object.keys(DEFAULTS)) {
    if (userTre[k] !== undefined) {
      config.tre[k] = userTre[k];
    } else if (config.tre[k] === undefined) {
      config.tre[k] = DEFAULTS[k];
    }
  }
});
