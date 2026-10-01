import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ble } from '../js/ble.js';
import { createMockBluetooth } from '../js/mock.js';
import { PROTOCOL } from '../js/protocol.js';
import { canonicalUUID, sleep } from '../js/util.js';

const FFF0 = canonicalUUID(0xfff0);
const KEY = {
  fff1: `${FFF0}/${canonicalUUID(0xfff1)}`,
  fff2: `${FFF0}/${canonicalUUID(0xfff2)}`,
  name: `${canonicalUUID(0x1800)}/${canonicalUUID(0x2a00)}`,
};

async function setup(optionalServices = PROTOCOL.optionalServices, hub = {}) {
  const bt = createMockBluetooth({ pickerDelay: 0, ...hub });
  const ble = new Ble(bt);
  const log = [];
  ble.addEventListener('log', e => log.push(e.detail));
  ble.addEventListener('error', () => {});
  await ble.connect({ optionalServices });
  return { bt, ble, log };
}

async function teardown(ble) {
  ble.disconnect();
  await sleep(5);
}

test('discovers only services listed in optionalServices', async () => {
  const { ble } = await setup([0xfff0].map(canonicalUUID));
  assert.deepEqual(ble.services.map(s => s.uuid), [FFF0]);
  await teardown(ble);
});

test('discovers the full CB10 shape with properties', async () => {
  const { ble } = await setup();
  assert.equal(ble.state, 'connected');
  assert.equal(ble.services.length, 2);
  assert.deepEqual(ble.chars.get(KEY.fff1).info.props.notify, true);
  assert.deepEqual(ble.chars.get(KEY.fff2).info.props.write, true);
  await teardown(ble);
});

test('parallel operations are serialised (mock rejects overlapping ops)', async () => {
  const { bt, ble } = await setup();
  const ops = [];
  for (let i = 0; i < 10; i++) ops.push(ble.write(KEY.fff2, [i]), ble.read(KEY.fff1));
  await Promise.all(ops);
  assert.equal(bt.mock.device.writes.length, 10);
  // Sanity check that the mock really enforces it.
  const c = ble.chars.get(KEY.fff1).c;
  await assert.rejects(Promise.all([c.readValue(), c.readValue()]), /already in progress/);
  await teardown(ble);
});

test('Generic Access writes are blocked unless allowed', async () => {
  const { bt, ble } = await setup(undefined, { genericAccess: true });
  await assert.rejects(ble.write(KEY.name, [0x41]), /Blocked/);
  assert.equal(bt.mock.device.writes.length, 0);
  ble.allowGenericAccessWrites = true;
  await ble.write(KEY.name, [0x41]);
  await teardown(ble);
});

test('notifications are logged, read echoes are not', async () => {
  const { ble, log } = await setup();
  await ble.subscribe(KEY.fff1);
  await ble.read(KEY.fff1);
  assert.equal(log.filter(e => e.dir === 'R').length, 1);
  assert.equal(log.filter(e => e.dir === 'N').length, 0);
  await ble.write(KEY.fff2, [0x01, 0x02]);
  await sleep(80);
  const n = log.filter(e => e.dir === 'N');
  assert.deepEqual(Array.from(n.at(-1).bytes), [0x88, 0x80, 0xff, 0xff, 0xff, 0xff, 0x7c, 0xdd]);
  await teardown(ble);
});

test('writeLatest coalesces to the newest value and paces writes', async () => {
  const { bt, ble } = await setup();
  ble.maxWritesPerSecond = 20;
  for (let i = 0; i < 50; i++) ble.writeLatest('slot', KEY.fff2, [i]);
  await sleep(200);
  const writes = bt.mock.device.writes;
  assert.ok(writes.length <= 3, `expected few writes, got ${writes.length}`);
  assert.deepEqual(Array.from(writes.at(-1).bytes), [49]);
  await teardown(ble);
});

test('clearPending drops queued writes', async () => {
  const { bt, ble } = await setup();
  const ops = [1, 2, 3, 4].map(i => ble.write(KEY.fff2, [i]).then(() => 'ok', e => e.name));
  ble.clearPending();
  const results = await Promise.all(ops);
  assert.deepEqual(results, ['ok', 'AbortError', 'AbortError', 'AbortError']);
  assert.equal(bt.mock.device.writes.length, 1);
  await teardown(ble);
});

test('connection loss, then reconnect re-subscribes', async () => {
  const { bt, ble, log } = await setup();
  await ble.subscribe(KEY.fff1);
  const lost = new Promise(r => ble.addEventListener('disconnected', e => r(e.detail), { once: true }));
  bt.mock.drop();
  assert.deepEqual(await lost, { user: false });
  assert.equal(ble.state, 'disconnected');
  await assert.rejects(ble.write(KEY.fff2, [1]), /Not connected/);
  await ble.reconnect();
  assert.equal(ble.state, 'connected');
  assert.ok(ble.subscribed.has(KEY.fff1));
  assert.ok(bt.mock.device.fff1.notifying);
  assert.ok(log.some(e => e.text === 'Connection lost'));
  await teardown(ble);
});

test('picker filter by name prefix', async () => {
  const ble = new Ble(createMockBluetooth({ pickerDelay: 0 }));
  await assert.rejects(ble.connect({ namePrefix: 'XYZ' }), /picker cancelled/);
  assert.equal(ble.state, 'disconnected');
});
