'use strict';

// Poll the full-node's unconfirmed view for a tx receipt. The
// Solidity-node view only returns data for solidified blocks, which
// never happens on a single-node TRE regtest — so we hit
// `getUnconfirmedTransactionInfo` first and only fall back to the
// solidified view as a hedge for public networks.

const { mine, isTransientFetchError } = require('./cheatcodes');

// JSON parser that preserves integer precision above 2^53. TVM's
// transaction-info response embeds `callValueInfo[*].callValue` (and
// similar fields) as raw JSON integers up to Long.MAX_VALUE
// (~9.22e18 sun). `JSON.parse` quantizes anything above 2^53 to the
// nearest IEEE-754 double — so a value like 999999999999999999 reads
// back as 1000000000000000000, and chai-matchers' balance assertions
// fire off-by-1-wei. We pre-process the text body, wrapping every
// integer >= 2^53 in quotes (turning it into a JSON string), then
// hand to `JSON.parse`. Downstream readers do `BigInt(value)` which
// accepts both strings and numbers, so wrapping is non-breaking.
//
// Hot-path note: the regex below is expensive on long bodies. Most
// responses contain NO integers above 2^53 (15-16 decimal digits) —
// callValue is only large for parseEther-scale transfers. A cheap
// pre-scan via `.test` short-circuits the regex on the common case.
const _LARGE_INT_RE = /(:|,|\[)\s*(-?\d{16,})(?=\s*[,\]\}])/g;
const _PRESCAN_RE = /\d{16,}/;
function jsonParseBigSafe(text) {
  if (!_PRESCAN_RE.test(text)) return JSON.parse(text);
  const safeLimit = 9007199254740992n; // 2^53
  const rewritten = text.replace(_LARGE_INT_RE, (_, before, digits) => {
    let n;
    try {
      n = BigInt(digits);
    } catch {
      return before + digits;
    }
    const abs = n < 0n ? -n : n;
    return abs >= safeLimit ? `${before}"${digits}"` : `${before}${digits}`;
  });
  return JSON.parse(rewritten);
}

async function _getInfoBigSafe(tronWeb, txId, endpoint) {
  // Use the same fullnode host TronWeb is configured with; bypass
  // TronWeb's JSON parsing (lossy on large integers).
  const base = tronWeb.fullNode.host.replace(/\/$/, '');
  const url = base + endpoint;
  const fetchText = async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: txId }),
    });
    return resp.text();
  };
  // Single retry on a connection-level error ("fetch failed", "other side
  // closed", ECONNRESET, …) on EITHER the request or the body read. java-tron
  // under G1GC with -Xmx2g can stop-the-world for 50–200 ms late in long
  // parallel runs; a pause exceeding the HTTP keep-alive timeout drops the
  // socket and surfaces here. Without a retry, one dropped poll fails the test
  // — and because every later fixture's waitForReceipt hits the same node, it
  // cascades the rest of the worker. Mirrors rpcCall's retry (cheatcodes.js).
  let text;
  try {
    text = await fetchText();
  } catch (e) {
    if (!isTransientFetchError(e)) throw e;
    await new Promise((r) => setTimeout(r, 100));
    text = await fetchText();
  }
  if (!text) return null;
  return jsonParseBigSafe(text);
}

async function waitForReceipt(tronWeb, txId, { timeout = 240_000 } = {}) {
  const deadline = Date.now() + timeout;
  let iter = 0;
  // `tronContract.method(...).send()` internally drives a single block
  // production cycle (verified by probe: block advances by exactly 1
  // per .send() call with no manual mine). So we DON'T pre-mine here —
  // pre-mining would produce an EXTRA empty block per tx, throwing off
  // tests that depend on precise block-count semantics (e.g. ERC20Votes'
  // "recent checkpoints" test expecting 6 mints = 6 blocks).
  //
  // We DO still mine as a recovery hatch if the tx hasn't landed after
  // some polls — TRE's HTTP layer doesn't guarantee request ordering,
  // and on rare occasions the tx lands in a block we missed.
  //
  // Poll cadence: yield via `setImmediate` between RPC fetches instead
  // of `setTimeout(2)`. setImmediate is the fastest event-loop yield
  // (~0.1 ms vs ~1-2 ms), which matters at scale where each saved
  // millisecond compounds. The GET to TRE itself is the floor
  // (~5-15 ms), so we can't go faster than that — but we shouldn't be
  // slower either.
  while (Date.now() < deadline) {
    // Unconfirmed view is the cheap fast path. Some txs (especially
    // late in a long run) only surface via the CONFIRMED view — even
    // with TransactionStore snapshotted, TRE's HTTP layer can index a
    // tx into the solidified side first. Checking both means we don't
    // sit on a 60 s timeout when the receipt has actually been
    // computed.
    //
    // Use raw HTTP + BigInt-safe JSON parsing. TronWeb's
    // `getUnconfirmedTransactionInfo` quantizes any integer above 2^53
    // to the nearest IEEE-754 double, which corrupts
    // `callValueInfo[*].callValue` for parseEther-scale transfers (1e18
    // sun >> 2^53 ≈ 9e15). chai-matchers' balance assertions then fire
    // off-by-1-wei. Bypassing TronWeb's parser preserves every digit
    // through the JS→Java→JS round-trip.
    const info = await _getInfoBigSafe(tronWeb, txId, '/wallet/gettransactioninfobyid');
    if (info && info.receipt) return info;
    if (iter && iter % 3 === 0) {
      const confirmed = await _getInfoBigSafe(tronWeb, txId, '/walletsolidity/gettransactioninfobyid').catch(
        () => null,
      );
      if (confirmed && confirmed.receipt) return confirmed;
    }
    // Recovery mine every 5 iterations.
    if (iter && iter % 5 === 0) await mine(tronWeb).catch(() => {});
    iter++;
    await new Promise((r) => setImmediate(r));
  }
  // Fallback to the solidified view as a last-ditch hedge before
  // throwing — only meaningful on public networks (shasta/mainnet);
  // local TRE never reaches solidified state.
  const info = await _getInfoBigSafe(tronWeb, txId, '/walletsolidity/gettransactioninfobyid');
  if (info && info.receipt) return info;
  throw new Error(`Timed out waiting for receipt of tx ${txId}`);
}

module.exports = { waitForReceipt, jsonParseBigSafe };
