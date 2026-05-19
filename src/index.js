'use strict';

// HTTP keep-alive must install before any other module loads TronWeb
// or axios — those create their HTTP-agent instances at construction
// time and won't pick up a `globalAgent` change after the fact.
require('./runtime/http-agent');

const { extendEnvironment } = require('hardhat/config');

const treWeb = require('./runtime/tre-web');

extendEnvironment((hre) => {
  hre.tre = hre.tre || {};
  hre.tre.makeTronWeb = () => treWeb.makeTronWeb(hre);
});
