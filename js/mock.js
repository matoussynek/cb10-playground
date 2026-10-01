// Fake Web Bluetooth for development without hardware (?mock=1).
// GATT shape, reads and replies match what the real CB10 showed (docs/PROTOCOL.md). It deliberately mimics Chrome's quirks: only optionalServices are visible, overlapping GATT
// operations fail with "already in progress", and reads also fire characteristicvaluechanged.

import { canonicalUUID, toBytes } from './util.js';

const delay = ms => new Promise(r => setTimeout(r, ms));
const domError = (name, msg) => new DOMException(msg, name);
const view = bytes => new DataView(Uint8Array.from(bytes).buffer);
const ascii = s => Array.from(s, ch => ch.charCodeAt(0));

class MockCharacteristic extends EventTarget {
  constructor(service, uuid, props, initial = []) {
    super();
    this.service = service;
    this.uuid = canonicalUUID(uuid);
    this.properties = {
      broadcast: false, read: false, writeWithoutResponse: false, write: false, notify: false,
      indicate: false, authenticatedSignedWrites: false, reliableWrite: false, writableAuxiliaries: false,
      ...props,
    };
    this.value = null;
    this.data = initial;
    this.notifying = false;
    this.onWrite = null;
  }

  async readValue() {
    if (!this.properties.read) throw domError('NotSupportedError', 'GATT operation not permitted.');
    await this.service.device._op();
    this.value = view(this.data);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
    return this.value;
  }

  async writeValueWithResponse(value) {
    if (!this.properties.write) throw domError('NotSupportedError', 'GATT operation not permitted.');
    await this._write(value);
  }

  async writeValueWithoutResponse(value) {
    if (!this.properties.writeWithoutResponse && !this.properties.write) {
      throw domError('NotSupportedError', 'GATT operation not permitted.');
    }
    await this._write(value);
  }

  writeValue(value) {
    return this.writeValueWithResponse(value);
  }

  async startNotifications() {
    if (!this.properties.notify && !this.properties.indicate) throw domError('NotSupportedError', 'GATT operation not permitted.');
    await this.service.device._op();
    this.notifying = true;
    return this;
  }

  async stopNotifications() {
    await this.service.device._op();
    this.notifying = false;
    return this;
  }

  async _write(value) {
    const bytes = toBytes(ArrayBuffer.isView(value) ? value : new Uint8Array(value));
    if (bytes.length > 20) throw domError('NotSupportedError', 'Value is longer than the (mock) MTU of 20 bytes.');
    await this.service.device._op();
    this.data = Array.from(bytes);
    this.onWrite?.(bytes);
  }

  emit(bytes) {
    if (!this.notifying || !this.service.device.gatt.connected) return;
    this.value = view(bytes);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class MockService {
  constructor(device, uuid) {
    this.device = device;
    this.uuid = canonicalUUID(uuid);
    this.isPrimary = true;
    this.chars = [];
  }

  add(uuid, props, initial) {
    const c = new MockCharacteristic(this, uuid, props, initial);
    this.chars.push(c);
    return c;
  }

  async getCharacteristics(uuid) {
    await this.device._op();
    const list = uuid ? this.chars.filter(c => c.uuid === canonicalUUID(uuid)) : this.chars;
    if (!list.length) throw domError('NotFoundError', 'No Characteristics matching UUID found in Service.');
    return [...list];
  }

  async getCharacteristic(uuid) {
    return (await this.getCharacteristics(uuid))[0];
  }
}

class MockServer {
  constructor(device) {
    this.device = device;
    this.connected = false;
  }

  async connect() {
    await delay(300);
    this.connected = true;
    this.device._start();
    return this;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.device._stop();
    setTimeout(() => this.device.dispatchEvent(new Event('gattserverdisconnected')), 0);
  }

  async getPrimaryServices(uuid) {
    await this.device._op();
    let list = this.device.services.filter(s => this.device.allowed.has(s.uuid));
    if (uuid) list = list.filter(s => s.uuid === canonicalUUID(uuid));
    if (!list.length) throw domError('NotFoundError', 'No Services matching UUID found in Device.');
    return list;
  }

  async getPrimaryService(uuid) {
    return (await this.getPrimaryServices(uuid))[0];
  }
}

class MockDevice extends EventTarget {
  constructor({ channel = 1, genericAccess = false } = {}) {
    super();
    this.id = 'mock-cb10';
    this.name = 'CB10-MOCK0001';
    this.gatt = new MockServer(this);
    this.allowed = new Set();
    this.busy = false;
    this.channel = channel;
    this.motors = { A: 0x80, B: 0x80 };
    this.writes = [];

    // Chrome exposed only these two services on the real hub; Generic Access is opt-in for tests.
    const fff0 = new MockService(this, 0xfff0);
    this.fff1 = fff0.add(0xfff1, { read: true, notify: true }, [0, 0, 0, 0]);
    this.fff2 = fff0.add(0xfff2, { write: true });
    const rg = new MockService(this, '00005247-0001-1000-8000-00805f9b34fb');
    this.c5248 = rg.add('00005248-0002-1000-8000-00805f9b34fb', { write: true });
    rg.add('00005249-0003-1000-8000-00805f9b34fb', { read: true, notify: true }, [0, 0, 0, 0]);
    rg.add('0000524a-0003-1000-8000-00805f9b34fb', { notify: true });
    this.services = [fff0, rg];
    if (genericAccess) {
      const ga = new MockService(this, 0x1800);
      ga.add(0x2a00, { read: true, write: true }, ascii(this.name));
      ga.add(0x2a01, { read: true, write: true }, [0x00, 0x00]);
      this.services.unshift(ga);
    }

    this.fff2.onWrite = bytes => {
      this.writes.push({ uuid: this.fff2.uuid, bytes });
      const reply = this._handle(bytes);
      setTimeout(() => this.fff1.emit(reply), 30);
    };
    this.c5248.onWrite = bytes => this.writes.push({ uuid: this.c5248.uuid, bytes });
  }

  // Replies as observed on the real hub (docs/PROTOCOL.md).
  _handle(b) {
    const header = 0x80 + this.channel - 1;
    const ignored = [0x88, 0x80, 0xff, 0xff, 0xff, 0xff, 0x7c, 0xdd];
    if (b[0] !== header) return ignored;
    const valid = b.length === 16 && b[15] === 0xdd && b[1] === 0x80
      && (b.slice(1, 14).reduce((a, x) => a + x, 0) & 0xff) === b[14];
    if (!valid) return [0, 0, 0, 0, 0, 0, 0, 0];
    // Frame pair 1 drives the socket labelled B, pair 2 the one labelled A.
    this.motors = { B: b[3], A: b[5] };
    this.dispatchEvent(new CustomEvent('motors', { detail: { ...this.motors } }));
    return [0x88, header, 0, 0, 0, 0, header, 0xdd]; // checksum of [header, 0, 0, 0, 0] is header
  }

  // Simulates the BLE stack: one operation at a time, with latency.
  async _op() {
    if (!this.gatt.connected) throw domError('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.');
    if (this.busy) throw domError('NetworkError', 'GATT operation already in progress.');
    this.busy = true;
    try {
      await delay(10 + Math.random() * 30);
    } finally {
      this.busy = false;
    }
    if (!this.gatt.connected) throw domError('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.');
  }

  _start() {}

  _stop() {
    this.busy = false;
    for (const s of this.services) for (const c of s.chars) c.notifying = false;
    // A real hub would keep running; the mock stops so the UI state stays easy to follow.
    this.motors = { A: 0x80, B: 0x80 };
    this.dispatchEvent(new CustomEvent('motors', { detail: { ...this.motors } }));
  }
}

export function createMockBluetooth({ pickerDelay = 400, known = false, ...hub } = {}) {
  const device = new MockDevice(hub);
  const bluetooth = new EventTarget();
  let granted = known;
  // A "known" hub behaves like one the browser remembers from an earlier visit.
  if (known) for (const s of device.services) device.allowed.add(s.uuid);

  bluetooth.getAvailability = async () => true;
  bluetooth.getDevices = async () => (granted ? [device] : []);
  device.watchAdvertisements = async ({ signal } = {}) => {
    const t = setTimeout(() => device.dispatchEvent(new Event('advertisementreceived')), 300);
    signal?.addEventListener('abort', () => clearTimeout(t), { once: true });
  };

  bluetooth.requestDevice = async (options = {}) => {
    const { filters, acceptAllDevices, optionalServices = [] } = options;
    if (!!filters === !!acceptAllDevices) {
      throw new TypeError("Either 'filters' should be present or 'acceptAllDevices' should be true, but not both.");
    }
    await delay(pickerDelay);
    const matches = acceptAllDevices || filters.some(f => !f.namePrefix || device.name.startsWith(f.namePrefix));
    if (!matches) throw domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
    for (const f of filters || []) for (const s of f.services || []) device.allowed.add(canonicalUUID(s));
    for (const s of optionalServices) device.allowed.add(canonicalUUID(s));
    granted = true;
    return device;
  };

  bluetooth.mock = {
    device,
    drop: () => device.gatt.disconnect(),
  };
  return bluetooth;
}
