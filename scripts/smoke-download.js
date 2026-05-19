#!/usr/bin/env node
'use strict';

// Standalone smoke test for the tron-solc downloader. Exercises the
// fetch + SHA-256 verify + atomic-stage path end to end against the
// canonical `tronprotocol/solc-bin` mirror without going through
// Hardhat — useful for diagnosing manifest / network issues in
// isolation.
//
// Usage:
//   node scripts/smoke-download.js [version] [mirror]
//
// Defaults:
//   version = 0.8.26
//   mirror  = https://raw.githubusercontent.com/tronprotocol/solc-bin/main
//
// Exit codes:
//   0 — download succeeded, verification passed
//   1 — TronCompileError surfaced from the downloader
//   2 — argument / environment problem

const path = require('node:path');

const downloader = require('../src/compile/downloader');
const { knownVersions } = require('../src/compile/manifest');

const DEFAULT_VERSION = '0.8.26';
const DEFAULT_MIRROR = 'https://raw.githubusercontent.com/tronprotocol/solc-bin/main';

async function main() {
  const version = process.argv[2] || DEFAULT_VERSION;
  const mirror = process.argv[3] || DEFAULT_MIRROR;

  process.stdout.write(`[smoke] downloading tron-solc ${version} from ${mirror}\n`);
  const started = Date.now();
  let result;
  try {
    result = await downloader.getCompiler(version, { mirror });
  } catch (e) {
    process.stderr.write(`[smoke] download failed: ${e.message}\n`);
    process.exit(1);
  }
  const elapsedMs = Date.now() - started;

  process.stdout.write(`[smoke] OK in ${elapsedMs} ms\n`);
  process.stdout.write(`        version:      ${result.version}\n`);
  process.stdout.write(`        longVersion:  ${result.longVersion}\n`);
  process.stdout.write(`        compilerPath: ${path.relative(process.cwd(), result.compilerPath)}\n`);

  try {
    const versions = await knownVersions({ mirror });
    process.stdout.write(`[smoke] manifest reports ${versions.length} known versions\n`);
  } catch (e) {
    process.stderr.write(`[smoke] manifest re-read failed: ${e.message}\n`);
    process.exit(2);
  }
}

main();
