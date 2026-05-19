'use strict';

// HTTP keep-alive shim — installs persistent-connection agents for
// every outgoing request the plugin issues. Without this, every
// `fetch()` and every TronWeb HTTP call opens a new TCP connection
// and pays SYN/SYN-ACK/ACK on each request (~1–3 ms wire, scaling
// linearly with concurrent file handles). At ~30k HTTP ops per typical
// suite that's 30–90 s of pure handshake noise even before the JVM
// touches the request.
//
// Two distinct HTTP stacks live inside Node, both need the same
// treatment:
//   * `node:http` / `node:https` — used by axios (which TronWeb's
//     HttpProvider configures internally). Override `http.globalAgent`
//     so any consumer that doesn't pass its own `agent` opt picks up
//     keep-alive automatically.
//   * `undici` — backs Node's built-in `fetch()` (Node 18+). undici
//     has its own dispatcher; set a global one with keep-alive.
//
// Idempotent: installs once per module-load.

const http = require('node:http');
const https = require('node:https');

const KEEP_ALIVE_OPTS = {
  keepAlive: true,
  // Cap the per-host pool size. The plugin talks to one TRE per
  // worker (≤6 workers max), so 50 sockets is plenty of headroom for
  // parallel fixture-load + receipt-poll patterns without exhausting
  // the kernel's file-descriptor budget.
  maxSockets: 50,
  maxFreeSockets: 10,
  // Keep idle sockets warm for ~30 s. Tests usually run in tight
  // succession; cooling them off too aggressively defeats the point.
  keepAliveMsecs: 30000,
};

http.globalAgent = new http.Agent(KEEP_ALIVE_OPTS);
https.globalAgent = new https.Agent(KEEP_ALIVE_OPTS);

// undici (Node's built-in fetch dispatcher). When the `undici`
// package is reachable, set a global dispatcher with keep-alive; if
// it's not installed transitively, fall through silently rather than
// break module load.
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(
    new Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
      connections: 50,
      // pipelining intentionally left at the undici default (1 in
      // flight per socket). A higher value produces head-of-line
      // blocking when `/wallet/broadcasttransaction` stalls under JVM
      // GC: a single slow broadcast wedges every subsequent request
      // on the same socket. Connection reuse via keep-alive is the
      // real win; pipelining is the wrong knob for this workload.
    }),
  );
} catch {
  // undici not reachable — leave fetch() with its default dispatcher.
}

module.exports = {};
