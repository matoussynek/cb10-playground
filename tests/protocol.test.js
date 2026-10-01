import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checksum, frame, speedByte, encodeMotors, encodeStop, encodeStopAll, decodeNotification,
} from '../js/protocol.js';
import { parseHex, toHex } from '../js/util.js';

const hex = bytes => toHex(bytes);

// Packets from docs/PROTOCOL.md "Verified examples" (sessions 9-10).
const STOP_CH1 = '80 80 F0 80 F0 80 FF FF FF FF FF FF FF FF 58 DD';
const PAIR1_30_CH1 = '80 80 F0 9E F0 80 FF FF FF FF FF FF FF FF 76 DD';
const PAIR2_FULL_CH1 = '80 80 F0 80 F0 FF FF FF FF FF FF FF FF FF D7 DD';
const REPLY_OK = '88 80 00 00 00 00 80 DD';
const REPLY_IGNORED = '88 80 FF FF FF FF 7C DD';

test('checksum is the low byte of the data sum, matching captured replies', () => {
  assert.equal(checksum([0x80, 0xff, 0xff, 0xff, 0xff]), 0x7c);
  assert.equal(hex(frame(0x88, [0x80, 0xff, 0xff, 0xff, 0xff])), REPLY_IGNORED);
  assert.equal(hex(frame(0x88, [0x80, 0, 0, 0, 0])), REPLY_OK);
});

test('speedByte mirrors the app dial mapping', () => {
  assert.equal(speedByte(0), 0x80);
  assert.equal(speedByte(30), 0x9e);
  assert.equal(speedByte(-30), 0x62);
  assert.equal(speedByte(99), 0xe3);
  assert.equal(speedByte(100), 0xff);
  assert.equal(speedByte(-100), 0x00);
  assert.equal(speedByte(250), 0xff);
  assert.equal(speedByte(-0.4), 0x80);
  assert.throws(() => speedByte(NaN));
});

test('stop frames', () => {
  assert.equal(hex(encodeStop(1)), STOP_CH1);
  assert.equal(hex(encodeStop(2)), '81' + STOP_CH1.slice(2));
  assert.equal(hex(encodeStop(4)), '83' + STOP_CH1.slice(2));
  assert.deepEqual(encodeStopAll(3).map(f => f[0]), [0x82, 0x80, 0x81, 0x83]);
  assert.throws(() => encodeStop(0));
  assert.throws(() => encodeStop(5));
});

test('hub socket labels are swapped relative to frame order', () => {
  // Frame pair 1 = hub socket B, pair 2 = hub socket A.
  assert.equal(hex(encodeMotors({ channel: 1, B: 30 })), PAIR1_30_CH1);
  assert.equal(hex(encodeMotors({ channel: 1, A: 100 })), PAIR2_FULL_CH1);
  assert.equal(hex(encodeMotors({ channel: 1, A: 100, B: 100 })), '80 80 F0 FF F0 FF FF FF FF FF FF FF FF FF 56 DD');
});

test('decodeNotification', () => {
  assert.deepEqual(decodeNotification(parseHex(REPLY_OK)), {
    valid: true, header: 0x88, data: [0x80, 0, 0, 0, 0], channel: 1, status: 'ok',
  });
  const ignored = decodeNotification(parseHex(REPLY_IGNORED));
  assert.equal(ignored.valid, true);
  assert.equal(ignored.status, 'ignored');
  assert.equal(decodeNotification(parseHex('88 80 00 00 00 00 81 DD')).valid, false);
  assert.equal(decodeNotification(parseHex('00 00 00 00 00 00 00 00')).valid, false);
});
