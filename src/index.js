'use strict';

const { extendEnvironment } = require('hardhat/config');

const treWeb = require('./runtime/tre-web');

extendEnvironment((hre) => {
  hre.tre = hre.tre || {};
  hre.tre.makeTronWeb = () => treWeb.makeTronWeb(hre);
});
