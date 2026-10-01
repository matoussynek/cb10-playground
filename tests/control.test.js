import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ble } from '../js/ble.js';
import { createMockBluetooth } from '../js/mock.js';
import { createMotors, CMD_KEY } from '../js/control.js';
import { PROTOCOL } from '../js/protocol.js';
import { sleep, toHex } from '../js/util.js';

async function setup(hub) {
  const bt = createMockBluetooth({ pickerDelay: 0, ...hub });
  const ble = new Ble(bt);
  ble.addEventListener('error', () => {});
  const motors = createMotors(ble);
  await ble.connect({ optionalServices: PROTOCOL.optionalServices });
  await sleep(700); // auto channel detection on connect
  return { bt, ble, motors, hub: bt.mock.device };
}

const teardown = async ble => { ble.disconnect(); await sleep(5); };

test('detects the hub channel on connect', async () => {
  const { ble, motors } = await setup({ channel: 3 });
  assert.equal(motors.cfg.channel, 3);
  await teardown(ble);
});

test('drives the sockets by their printed labels, with cap and invert', async () => {
  const { ble, motors, hub } = await setup({ channel: 1 });
  motors.set({ A: 100 });
  await sleep(120);
  assert.deepEqual(hub.motors, { A: 0xff, B: 0x80 });
  motors.configure('B', { invert: true, max: 50, min: 0 });
  motors.set({ A: 0, B: 80 });
  await sleep(120);
  assert.deepEqual(hub.motors, { A: 0x80, B: 0x80 - 40 });
  motors.configure('B', { invert: false, max: 100, min: 20 });
  await teardown(ble);
});

test('dead zone: 1..100 % is spread over min..max, 0 stays stop', async () => {
  const { ble, motors } = await setup({ channel: 1 });
  motors.configure('A', { min: 20, max: 100 });
  const at = v => { motors.set({ A: v }); return motors.output('A'); };
  assert.equal(at(0), 0);
  assert.equal(at(1), 20.8);
  assert.equal(at(50), 60);
  assert.equal(at(100), 100);
  assert.equal(at(-50), -60);
  motors.configure('A', { max: 60 });
  assert.equal(at(100), 60);
  assert.equal(at(50), 40);
  motors.configure('A', { min: 50, max: 30 });
  assert.equal(at(10), 30, 'a cap below the dead zone wins');
  motors.configure('A', { min: 20, max: 100 });
  motors.set({ A: 0 });
  await teardown(ble);
});

test('stopAll stops every channel, own channel first, and drops queued commands', async () => {
  const { ble, motors, hub } = await setup({ channel: 2 });
  motors.set({ A: 60, B: 60 });
  await sleep(120);
  hub.writes.length = 0;
  motors.set({ A: 90 }); // still pending when STOP arrives
  await motors.stopAll('test');
  const headers = hub.writes.map(w => w.bytes[0]);
  assert.deepEqual(headers, [0x81, 0x80, 0x82, 0x83]);
  assert.ok(hub.writes.every(w => toHex(w.bytes).slice(2) === ' 80 F0 80 F0 80 FF FF FF FF FF FF FF FF 58 DD'));
  assert.deepEqual(hub.motors, { A: 0x80, B: 0x80 });
  assert.deepEqual(motors.speeds, { A: 0, B: 0 });
  await teardown(ble);
});

test('rapid input is coalesced', async () => {
  const { ble, motors, hub } = await setup({ channel: 1 });
  hub.writes.length = 0;
  for (let v = 0; v <= 100; v += 2) motors.set({ A: v });
  await sleep(250);
  assert.ok(hub.writes.length <= 6, `got ${hub.writes.length} writes`);
  assert.equal(hub.motors.A, 0xff);
  assert.ok(hub.writes.every(w => w.uuid === CMD_KEY.split('/')[1]));
  await teardown(ble);
});
