//
// plugin/http-agent.js
//
// HTTP keep-alive shim — installs persistent-connection agents for
// every outgoing request the plugin issues. Without this, every
// `fetch()` and every TronWeb HTTP call opens a new TCP connection
// and pays SYN/SYN-ACK/ACK on each request (~1–3 ms wire, scaling
// linearly with concurrent file handles). At ~30k HTTP ops per OZ
// suite that's 30–90 s of pure handshake noise even before the JVM
// touches the request.
//
// Two distinct HTTP stacks live inside Node, both need the same
// treatment:
//   * `node:http` / `node:https` — used by axios (which TronWeb's
//     HttpProvider configures internally). Override `http.globalAgent`
//     so any consumer that doesn't pass its own `agent` opt picks
//     up keep-alive automatically.
//   * `undici` — backs Node's built-in `fetch()` (Node 18+).
//     undici has its own dispatcher; set a global one with keep-alive.
//
// Idempotent: installs once per module-load.
//

const http = require('node:http');
const https = require('node:https');

const KEEP_ALIVE_OPTS = {
  keepAlive: true,
  // Cap the per-host pool size. We talk to one TRE per worker (≤6
  // workers max), so 50 sockets is plenty of headroom for parallel
  // fixture-load + receipt-poll patterns without exhausting kernel
  // fd budget.
  maxSockets: 50,
  maxFreeSockets: 10,
  // Keep idle sockets warm for ~30 s. Tests usually run in tight
  // succession; cooling them off too aggressively defeats the point.
  keepAliveMsecs: 30000,
};

http.globalAgent = new http.Agent(KEEP_ALIVE_OPTS);
https.globalAgent = new https.Agent(KEEP_ALIVE_OPTS);

// undici (Node's built-in fetch dispatcher). On Node 18+ this is
// always available. Older Node falls back to whatever fetch polyfill
// is loaded — if undici isn't available, we just silently skip.
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(
    new Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
      connections: 50,
      // pipelining intentionally left at the undici default (1 in
      // flight per socket). Earlier we tried pipelining=10 to overlap
      // ack-wait on slow /wallet/broadcasttransaction calls; in
      // practice it produced head-of-line blocking — a single 30ms
      // broadcast stalled every subsequent request on the same
      // socket, regressing v5 wall-clock from 37m to 43m. Connection
      // reuse via keepAlive alone is the real win (~1-3ms/call); HOL
      // blocking on TVM's sync handler is the real cost.
    }),
  );
} catch {
  // undici not installed — fetch() implementation is unknown.
  // Skip silently rather than fail boot.
}

module.exports = {};
