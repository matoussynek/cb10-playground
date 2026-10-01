import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHex, toHex, toDec, toAscii, canonicalUUID, shortUUID, keyLabel, sweepValues, SWEEP_MAX, parseIntLoose,
} from '../js/util.js';

const arr = u8 => Array.from(u8);

test('parseHex accepts the documented formats', () => {
  assert.deepEqual(arr(parseHex('01 02 ff')), [1, 2, 255]);
  assert.deepEqual(arr(parseHex('0x01,0x02')), [1, 2]);
  assert.deepEqual(arr(parseHex('0102ff')), [1, 2, 255]);
  assert.deepEqual(arr(parseHex('  01\t02\n FF ')), [1, 2, 255]);
  assert.deepEqual(arr(parseHex('1 2 f')), [1, 2, 15]);
  assert.deepEqual(arr(parseHex('0x0102')), [1, 2]);
  assert.deepEqual(arr(parseHex('01:02-03;04')), [1, 2, 3, 4]);
  assert.deepEqual(arr(parseHex('')), []);
});

test('parseHex rejects bad input', () => {
  assert.throws(() => parseHex('0g'), /Not hex/);
  assert.throws(() => parseHex('012'), /Odd/);
  assert.throws(() => parseHex('0x'), /Not hex/);
});

test('byte formatting', () => {
  const b = Uint8Array.from([0x55, 0x01, 0x41, 0x7f]);
  assert.equal(toHex(b), '55 01 41 7F');
  assert.equal(toDec(b), '85 1 65 127');
  assert.equal(toAscii(b), 'U.A.');
});

test('UUID helpers', () => {
  assert.equal(canonicalUUID(0xfff0), '0000fff0-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalUUID('FFF1'), '0000fff1-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalUUID('0x180F'), '0000180f-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalUUID('00005247-0001-1000-8000-00805F9B34FB'), '00005247-0001-1000-8000-00805f9b34fb');
  assert.throws(() => canonicalUUID('xyz'));
  assert.equal(shortUUID('0000fff1-0000-1000-8000-00805f9b34fb'), 'FFF1');
  assert.equal(shortUUID('00005248-0002-1000-8000-00805f9b34fb'), '5248…');
  assert.equal(
    keyLabel('00001800-0000-1000-8000-00805f9b34fb/00002a00-0000-1000-8000-00805f9b34fb'),
    '1800/2A00 Device Name',
  );
});

test('sweepValues', () => {
  assert.deepEqual(sweepValues(0, 4, 2), [0, 2, 4]);
  assert.deepEqual(sweepValues(5, 3, 1), [5, 4, 3]);
  assert.deepEqual(sweepValues(7, 7, 1), [7]);
  assert.equal(sweepValues(0, SWEEP_MAX - 1, 1).length, SWEEP_MAX);
  assert.throws(() => sweepValues(0, 255, 1), /cap/);
  assert.throws(() => sweepValues(0, 256, 1));
  assert.throws(() => sweepValues(0, 10, 0));
});

test('parseIntLoose', () => {
  assert.equal(parseIntLoose('16'), 16);
  assert.equal(parseIntLoose('0x10'), 16);
  assert.ok(Number.isNaN(parseIntLoose('1.5')));
});
