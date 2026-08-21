'use strict';

// Regression coverage for the codec/JSON surface PR #35 moved out of
// hardhat-tron's inline implementations and into the published
// @openzeppelin/tron-runtime package. Two behavior-sensitive paths are
// exercised:
//
//   1. Address codecs — the runtime's `toEvmAddress` / `toBase58Address`
//      (EVM hex ⇄ TRON base58), and the hardhat-side wrappers that layer
//      EIP-55 checksumming + lenient object/edge handling on top of them:
//      `tronToHex` / `toTronBase58` exported from src/runtime/ethers-bridge.js.
//   2. `jsonParseBigSafe` — BigInt-safe JSON parsing used by
//      src/runtime/wait.js so >2^53 sun balances/callValues survive the
//      JS→Java→JS round-trip without IEEE-754 quantization.
//
// PR #35 shipped these with zero tests; this file closes that gap.
//
// Determinism: no property-testing library is used. Randomized inputs
// come from a fixed-seed mulberry32 PRNG so every run is byte-identical.
// `ethers.getAddress` is used as an INDEPENDENT oracle for EIP-55
// checksumming; `TronWeb.address.toHex` as an independent oracle for the
// base58 → 41-hex decode (both are separate code paths from the runtime's
// public API under test).

const { expect } = require('chai');
const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');

const { toEvmAddress, toBase58Address, jsonParseBigSafe } = require('@openzeppelin/tron-runtime');

// ethers-bridge.js calls `extendEnvironment` at module-load time, which
// requires a live HardhatContext. Create a bare one before requiring the
// bridge so its exported wrappers (`tronToHex` / `toTronBase58`) are
// available without booting a full Hardhat runtime or a TRE container.
const { HardhatContext } = require('hardhat/internal/context');
if (!HardhatContext.isCreated()) {
  HardhatContext.createHardhatContext();
}
const { tronToHex, toTronBase58 } = require('../src/runtime/ethers-bridge');

// -- Deterministic PRNG ------------------------------------------------
// mulberry32: tiny, fast, fully deterministic given a fixed seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';
function randomEvmAddress(rng) {
  let out = '0x';
  for (let i = 0; i < 40; i++) out += HEX[Math.floor(rng() * 16)];
  return out;
}

// Independent oracle: decode a base58 T-address back to lowercase EVM hex
// via TronWeb (a code path distinct from the runtime's toEvmAddress).
function base58ToEvmViaTronWeb(base58) {
  return '0x' + TronWeb.address.toHex(base58).slice(2).toLowerCase();
}

// Known EVM-hex ⇄ base58 vectors, cross-checked against TronWeb.
const KNOWN_VECTORS = [
  { evm: '0x0000000000000000000000000000000000000000', base58: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' },
  { evm: '0xffffffffffffffffffffffffffffffffffffffff', base58: 'TZJozAg1ruapycCicgz31GxvYJ1FraLjZa' },
  { evm: '0x0000000000000000000000000000000000000001', base58: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKLxmGkn' },
  { evm: '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c', base58: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
];

describe('runtime address codecs (toEvmAddress / toBase58Address)', function () {
  describe('known vectors', function () {
    KNOWN_VECTORS.forEach(({ evm, base58 }) => {
      it(`round-trips ${evm} ⇄ ${base58}`, function () {
        // Forward: EVM hex → base58 matches the pinned vector.
        expect(toBase58Address(evm)).to.equal(base58);
        // Reverse: base58 → EVM hex is the lowercase original.
        expect(toEvmAddress(base58)).to.equal(evm);
        // Full round-trip through both codecs.
        expect(toEvmAddress(toBase58Address(evm))).to.equal(evm);
        // Independent oracle agrees on the base58 → hex decode.
        expect(base58ToEvmViaTronWeb(base58)).to.equal(evm);
      });
    });
  });

  describe('round-trip over seeded random addresses', function () {
    it('EVM hex → base58 → EVM hex is identity for ~1000 random addresses', function () {
      const rng = mulberry32(0x1234abcd);
      for (let i = 0; i < 1000; i++) {
        const evm = randomEvmAddress(rng);
        const base58 = toBase58Address(evm);
        // Every base58 output is a well-formed TRON address.
        expect(base58).to.match(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
        expect(TronWeb.isAddress(base58)).to.equal(true);
        // Round-trip through the runtime codec is lossless (lowercase).
        expect(toEvmAddress(base58)).to.equal(evm);
        // Independent oracle confirms the decode.
        expect(base58ToEvmViaTronWeb(base58)).to.equal(evm);
      }
    });
  });

  describe('EIP-55 checksumming', function () {
    it('runtime toEvmAddress emits LOWERCASE (checksum applied by the hardhat wrapper, not the codec)', function () {
      // Documents where checksumming lives: the runtime codec returns a
      // lowercase address; ethers-bridge's tronToHex re-derives EIP-55.
      const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
      expect(toEvmAddress(mixed)).to.equal(mixed.toLowerCase());
    });

    it('tronToHex output equals ethers.getAddress for ~1000 random addresses (any input encoding)', function () {
      const rng = mulberry32(0x55aa55aa);
      for (let i = 0; i < 1000; i++) {
        const evm = randomEvmAddress(rng);
        const oracle = ethers.getAddress(evm); // independent EIP-55 oracle
        const base58 = toBase58Address(evm);
        // Checksummed, regardless of whether we feed hex or base58 in.
        expect(tronToHex(evm)).to.equal(oracle);
        expect(tronToHex(base58)).to.equal(oracle);
        // And the base58 wrapper round-trips a checksummed address back to
        // the same base58 (idempotent on already-base58 input too).
        expect(toTronBase58(oracle)).to.equal(base58);
        expect(toTronBase58(base58)).to.equal(base58);
      }
    });

    it('runtime accepts any input casing (does NOT validate the incoming EIP-55 checksum)', function () {
      // Same 20 bytes, three casings — all normalize to the same base58.
      const lower = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';
      const upper = '0xA614F803B6FD780986A42C78EC9C7F77E6DED13C';
      const checksummed = ethers.getAddress(lower);
      const expected = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      expect(toBase58Address(lower)).to.equal(expected);
      expect(toBase58Address(upper)).to.equal(expected);
      expect(toBase58Address(checksummed)).to.equal(expected);
    });
  });

  describe('accepted input encodings', function () {
    it('accepts 0x-EVM hex, bare 40-hex, and 41-prefixed TRON hex', function () {
      const evm = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';
      const bare = 'a614f803b6fd780986a42c78ec9c7f77e6ded13c';
      const tronHex = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
      const expected = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      expect(toBase58Address(evm)).to.equal(expected);
      expect(toBase58Address(bare)).to.equal(expected);
      expect(toBase58Address(tronHex)).to.equal(expected);
      // toEvmAddress accepts the same three forms.
      expect(toEvmAddress(tronHex)).to.equal(evm);
      expect(toEvmAddress(bare)).to.equal(evm);
      expect(toEvmAddress('0x' + tronHex)).to.equal(evm); // 0x-prefixed 41-hex
    });
  });

  describe('edge addresses', function () {
    it('zero address round-trips and stresses base58 leading-zero handling', function () {
      const zero = '0x0000000000000000000000000000000000000000';
      const b58 = toBase58Address(zero);
      expect(b58).to.equal('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb');
      expect(toEvmAddress(b58)).to.equal(zero);
      expect(tronToHex(b58)).to.equal(ethers.getAddress(zero));
    });

    it('all-0xff address round-trips', function () {
      const ff = '0xffffffffffffffffffffffffffffffffffffffff';
      const b58 = toBase58Address(ff);
      expect(toEvmAddress(b58)).to.equal(ff);
      expect(tronToHex(b58)).to.equal(ethers.getAddress(ff));
    });

    it('addresses with many leading zero bytes round-trip', function () {
      // Leading zero bytes after the 0x41 prefix are the classic
      // base58check leading-zero hazard (each 0x00 byte → a leading "1").
      const cases = [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000100',
        '0x00000000000000000000000000000000000000ff',
        '0x000000000000000000000000000000000000dead',
      ];
      for (const evm of cases) {
        const b58 = toBase58Address(evm);
        expect(TronWeb.isAddress(b58)).to.equal(true);
        expect(toEvmAddress(b58)).to.equal(evm);
        expect(base58ToEvmViaTronWeb(b58)).to.equal(evm);
      }
    });

    it('handles mixed-case hex input (case-insensitive)', function () {
      const rng = mulberry32(0x0f0f0f0f);
      for (let i = 0; i < 50; i++) {
        const lower = randomEvmAddress(rng);
        // Randomly upper-case some nibbles.
        let mixed = '0x';
        for (let j = 2; j < lower.length; j++) {
          const ch = lower[j];
          mixed += rng() < 0.5 ? ch.toUpperCase() : ch;
        }
        expect(toBase58Address(mixed)).to.equal(toBase58Address(lower));
        expect(toEvmAddress(mixed)).to.equal(lower); // still lowercased out
      }
    });
  });

  describe('invalid inputs — runtime codecs THROW (intended: "Invalid TRON address")', function () {
    // Read from address.js: tronHexFromAddress throws for non-string,
    // empty, or anything not matching the EVM/TRON-hex/base58 forms.
    const bad = [
      ['empty string', ''],
      ['too short hex', '0x1234'],
      ['too long hex', '0x' + 'a'.repeat(41)],
      ['41 bytes wrong length', '0x' + 'a'.repeat(41)],
      ['non-hex chars', '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
      ['bare 39-hex', 'a'.repeat(39)],
      ['bare 41-hex', 'a'.repeat(41)],
      ['garbage base58-ish', 'TnotARealTronAddressAtAllXXXXXXXXXX'],
    ];
    bad.forEach(([label, input]) => {
      it(`toEvmAddress throws on ${label}`, function () {
        expect(() => toEvmAddress(input)).to.throw(/Invalid TRON address/);
      });
      it(`toBase58Address throws on ${label}`, function () {
        expect(() => toBase58Address(input)).to.throw(/Invalid TRON address/);
      });
    });

    // Non-string / nullish types: address.js's `typeof address !== 'string'`
    // guard throws the same error.
    const badTypes = [
      ['null', null],
      ['undefined', undefined],
      ['number', 1234],
      ['object', {}],
      ['array', []],
      ['bigint', 10n],
    ];
    badTypes.forEach(([label, input]) => {
      it(`toEvmAddress throws on ${label}`, function () {
        expect(() => toEvmAddress(input)).to.throw(/Invalid TRON address/);
      });
    });
  });

  describe('hardhat wrappers — LENIENT handling (intended, per ethers-bridge.js)', function () {
    // tronToHex: `if (!addr) return addr` — falsy passes through untouched
    // (it never reaches the runtime codec), so no throw for falsy inputs.
    it('tronToHex passes falsy inputs through unchanged (no throw)', function () {
      expect(tronToHex('')).to.equal('');
      expect(tronToHex(null)).to.equal(null);
      expect(tronToHex(undefined)).to.equal(undefined);
      expect(tronToHex(0)).to.equal(0);
    });

    it('tronToHex THROWS on a non-falsy but invalid string (delegates to the codec)', function () {
      // Non-empty invalid string reaches ethers.getAddress(toEvmAddress(...)),
      // which throws.
      expect(() => tronToHex('0x1234')).to.throw(/Invalid TRON address/);
    });

    // toTronBase58: only 0x-EVM (len 42) and 41-hex (len 42) are converted;
    // ANYTHING else — including already-base58 and unrecognized strings —
    // is returned as-is. Non-strings return as-is too.
    it('toTronBase58 returns unrecognized strings unchanged (no throw)', function () {
      expect(toTronBase58('0x1234')).to.equal('0x1234'); // wrong length
      expect(toTronBase58('not-an-address')).to.equal('not-an-address');
      expect(toTronBase58('')).to.equal('');
    });

    it('toTronBase58 returns already-base58 T-addresses unchanged', function () {
      const b58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      expect(toTronBase58(b58)).to.equal(b58);
    });

    it('toTronBase58 returns non-string values unchanged', function () {
      expect(toTronBase58(null)).to.equal(null);
      expect(toTronBase58(undefined)).to.equal(undefined);
      expect(toTronBase58(1234)).to.equal(1234);
    });

    it('toTronBase58 unwraps address-bearing objects (target / address / tronAddress)', function () {
      const b58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      const evm = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c';
      expect(toTronBase58({ tronAddress: b58 })).to.equal(b58);
      expect(toTronBase58({ target: evm })).to.equal(b58);
      expect(toTronBase58({ address: evm })).to.equal(b58);
    });
  });
});

describe('runtime jsonParseBigSafe', function () {
  describe('>2^53 integers survive without precision loss', function () {
    it('parses a real TRX-scale balance (90000000000000000000 sun) losslessly', function () {
      const text = '{"balance":90000000000000000000}';
      const parsed = jsonParseBigSafe(text);
      // Values >= 2^53 are emitted as decimal STRINGS so BigInt(value) is exact.
      expect(parsed.balance).to.be.a('string');
      expect(parsed.balance).to.equal('90000000000000000000');
      expect(BigInt(parsed.balance)).to.equal(90000000000000000000n);
    });

    it('proves plain JSON.parse WOULD lose precision on the same input', function () {
      const raw = '999999999999999999'; // 18 nines
      // Lossless path: exact.
      expect(BigInt(jsonParseBigSafe(raw))).to.equal(999999999999999999n);
      // Lossy path: JSON.parse quantizes to the nearest double, so the
      // decimal string no longer matches the input.
      expect(String(JSON.parse(raw))).to.not.equal(raw);
      expect(String(JSON.parse(raw))).to.equal('1000000000000000000');
    });
  });

  describe('2^53 boundary', function () {
    // 2^53 = 9007199254740992. SAFE_LIMIT is >=, so exactly 2^53 wraps.
    it('2^53 - 1 (max safe integer) stays a NUMBER', function () {
      const v = jsonParseBigSafe('9007199254740991');
      expect(v).to.be.a('number');
      expect(v).to.equal(9007199254740991);
    });
    it('2^53 exactly is wrapped to a STRING', function () {
      const v = jsonParseBigSafe('9007199254740992');
      expect(v).to.be.a('string');
      expect(BigInt(v)).to.equal(9007199254740992n);
    });
    it('2^53 + 1 is wrapped to a STRING (and JSON.parse would collapse it to 2^53)', function () {
      const v = jsonParseBigSafe('9007199254740993');
      expect(v).to.be.a('string');
      expect(BigInt(v)).to.equal(9007199254740993n);
      // The value 2^53+1 is not representable as a double — proof of hazard.
      expect(Number('9007199254740993')).to.equal(9007199254740992);
    });
  });

  describe('signs and zero', function () {
    it('large negative integers below -2^53 are wrapped to a STRING', function () {
      const v = jsonParseBigSafe('-90000000000000000000');
      expect(v).to.be.a('string');
      expect(BigInt(v)).to.equal(-90000000000000000000n);
    });
    it('-(2^53) exactly is wrapped (magnitude test uses abs)', function () {
      const v = jsonParseBigSafe('-9007199254740992');
      expect(v).to.be.a('string');
      expect(BigInt(v)).to.equal(-9007199254740992n);
    });
    it('small negatives stay numbers', function () {
      expect(jsonParseBigSafe('-5')).to.equal(-5);
    });
    it('zero stays a number', function () {
      expect(jsonParseBigSafe('0')).to.equal(0);
      expect(jsonParseBigSafe('{"x":0}').x).to.equal(0);
    });
  });

  describe('nested / mixed payloads (realistic TVM shapes)', function () {
    it('preserves big ints nested in objects and arrays while leaving small ones as numbers', function () {
      // Build the payload text by hand: JSON.stringify can't emit a raw
      // >2^53 integer without first collapsing it through a lossy Number.
      const raw =
        '{"receipt":{"energy_usage_total":33,"net_fee":280,"energy_fee":0},' +
        '"blockNumber":12,' +
        '"internal_transactions":[{"callValueInfo":[{"callValue":90000000000000000000}]}]}';
      const parsed = jsonParseBigSafe(raw);
      // Small ints untouched (still numbers).
      expect(parsed.receipt.energy_usage_total).to.equal(33);
      expect(parsed.receipt.net_fee).to.equal(280);
      expect(parsed.blockNumber).to.equal(12);
      // Big int preserved as a string, exact.
      const cv = parsed.internal_transactions[0].callValueInfo[0].callValue;
      expect(cv).to.be.a('string');
      expect(BigInt(cv)).to.equal(90000000000000000000n);
    });

    it('handles a mixed array of large and small integers positionally', function () {
      const raw = '[1, 90000000000000000000, -5, 9007199254740993, 0, 9007199254740991]';
      const arr = jsonParseBigSafe(raw);
      expect(arr[0]).to.equal(1);
      expect(arr[1]).to.be.a('string');
      expect(BigInt(arr[1])).to.equal(90000000000000000000n);
      expect(arr[2]).to.equal(-5);
      expect(arr[3]).to.be.a('string');
      expect(BigInt(arr[3])).to.equal(9007199254740993n);
      expect(arr[4]).to.equal(0);
      expect(arr[5]).to.equal(9007199254740991); // 2^53-1 stays a number
    });

    it('big ints as both object values and array elements in one payload', function () {
      const raw = '{"a":90000000000000000000,"b":[7,80000000000000000000],"c":"hello"}';
      const p = jsonParseBigSafe(raw);
      expect(BigInt(p.a)).to.equal(90000000000000000000n);
      expect(p.b[0]).to.equal(7);
      expect(BigInt(p.b[1])).to.equal(80000000000000000000n);
      expect(p.c).to.equal('hello');
    });
  });

  describe('non-integer / ordinary JSON is unchanged', function () {
    it('strings, booleans, null pass through', function () {
      expect(jsonParseBigSafe('"hello"')).to.equal('hello');
      expect(jsonParseBigSafe('true')).to.equal(true);
      expect(jsonParseBigSafe('false')).to.equal(false);
      expect(jsonParseBigSafe('null')).to.equal(null);
    });

    it('floats are left as JS numbers (BigInt cannot represent them; intended)', function () {
      expect(jsonParseBigSafe('1.5')).to.equal(1.5);
      expect(jsonParseBigSafe('{"x":3.14}').x).to.equal(3.14);
      // A float with a >=16-digit mantissa still stays a number (not wrapped).
      const v = jsonParseBigSafe('12345678901234567.5');
      expect(v).to.be.a('number');
    });

    it('exponent-form numbers are left untouched (not wrapped)', function () {
      const v = jsonParseBigSafe('9e19');
      expect(v).to.be.a('number');
      expect(v).to.equal(9e19);
    });

    it('digits INSIDE string literals are never rewritten', function () {
      const raw = '{"note":"balance is 90000000000000000000 sun","n":90000000000000000000}';
      const p = jsonParseBigSafe(raw);
      // The string is byte-identical...
      expect(p.note).to.equal('balance is 90000000000000000000 sun');
      // ...while the real number value is wrapped.
      expect(p.n).to.be.a('string');
      expect(BigInt(p.n)).to.equal(90000000000000000000n);
    });

    it('a large integer string VALUE is not double-wrapped', function () {
      const raw = '{"v":"90000000000000000000"}';
      expect(jsonParseBigSafe(raw).v).to.equal('90000000000000000000');
    });
  });

  describe('input validation (fail-closed)', function () {
    it('throws TypeError on non-string input', function () {
      expect(() => jsonParseBigSafe(null)).to.throw(TypeError);
      expect(() => jsonParseBigSafe(123)).to.throw(TypeError);
      expect(() => jsonParseBigSafe({})).to.throw(TypeError);
      expect(() => jsonParseBigSafe(undefined)).to.throw(TypeError);
    });

    it('throws SyntaxError on invalid JSON (does not silently "repair")', function () {
      expect(() => jsonParseBigSafe('{bad json}')).to.throw();
      expect(() => jsonParseBigSafe('')).to.throw();
      // A big-int-bearing but malformed payload must still be rejected, not
      // repaired by the rewrite pass.
      expect(() => jsonParseBigSafe('{"a":90000000000000000000,}')).to.throw();
      expect(() => jsonParseBigSafe('[90000000000000000000')).to.throw();
    });

    it('parses correctly when a 16+ digit run appears (prescan path) but stays valid', function () {
      // Exercises the PRESCAN_RE branch with a value that IS below 2^53.
      const v = jsonParseBigSafe('1000000000000000'); // 16 digits, < 2^53
      expect(v).to.equal(1000000000000000);
      expect(v).to.be.a('number');
    });
  });
});
