// Web Bluetooth wrapper: connect, discover, read, write, notify. Works with navigator.bluetooth or the mock.
//
// Events (CustomEvent, data in .detail):
//   state         'disconnected' | 'connecting' | 'connected'
//   gatt          services array [{ uuid, chars: [{ key, uuid, serviceUuid, props }] }]
//   log           { t, dir: 'W'|'R'|'N'|'I'|'E', key?, bytes?, text?, mode? }
//   value         { key, bytes, dir }  after every read and notification
//   subscriptions Set of subscribed keys
//   error         Error with a human-readable message
//   disconnected  { user: boolean }

import { canonicalUUID, toBytes, bytesEqual, now, toHex } from './util.js';

const GENERIC_ACCESS = canonicalUUID(0x1800);
const PROP_NAMES = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate',
  'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];

const abortError = msg => Object.assign(new Error(msg), { name: 'AbortError' });

export function isGenericAccess(key) {
  return key.startsWith(GENERIC_ACCESS + '/');
}

export function friendlyError(e) {
  if (e?.friendly) return e;
  const name = e?.name || 'Error';
  const msg = e?.message || String(e);
  let text = msg;
  if (name === 'NotFoundError' && /cancel/i.test(msg)) text = 'No device selected (picker cancelled).';
  else if (/adapter|bluetooth is (off|disabled)|radio/i.test(msg)) text = `Bluetooth is off or unavailable. Turn it on (Android: Location too) and retry. (${msg})`;
  else if (/already in progress/i.test(msg)) text = `GATT busy, another operation was still running. (${msg})`;
  else if (name === 'NetworkError') text = `GATT disconnected or connection failed. (${msg})`;
  else if (name === 'NotFoundError') text = `Not found: ${msg}`;
  else if (name === 'SecurityError') text = `Blocked by the browser: needs HTTPS/localhost, a user click, and the service listed in optionalServices. (${msg})`;
  else if (name === 'NotSupportedError') text = `Not supported by this characteristic. (${msg})`;
  else if (name === 'NotAllowedError') text = `Permission denied. (${msg})`;
  else if (name === 'InvalidStateError') text = `Invalid state, try reconnecting. (${msg})`;
  return Object.assign(new Error(text), { name, original: e, friendly: true });
}

export class Ble extends EventTarget {
  constructor(bluetooth) {
    super();
    this.bluetooth = bluetooth;
    this.device = null;
    this.server = null;
    this.state = 'disconnected';
    this.services = [];
    this.chars = new Map(); // key -> { c, info, handler }
    this.subscribed = new Set();
    this.allowGenericAccessWrites = false;
    this.maxWritesPerSecond = 20;

    this._queue = [];
    this._busy = false;
    this._latest = new Map();
    this._latestTimer = null;
    this._latestBusy = false;
    this._lastLatestAt = 0;
    this._reads = new Map();
    this._userDisconnect = false;
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  get connected() {
    return !!this.device?.gatt?.connected;
  }

  // Call straight from a click handler with no await before it: requestDevice() needs user activation.
  async connect({ namePrefix = 'CB10', acceptAll = false, optionalServices = [] } = {}) {
    const options = acceptAll
      ? { acceptAllDevices: true, optionalServices }
      : { filters: [{ namePrefix }], optionalServices };
    let device;
    try {
      device = await this.bluetooth.requestDevice(options);
    } catch (e) {
      throw friendlyError(e);
    }
    this._attach(device);
    await this._open();
  }

  // A device the browser already has permission for (navigator.bluetooth.getDevices()); connect with reconnect().
  useDevice(device) {
    this._attach(device);
  }

  // Reuses the same device object, so no picker and no user gesture needed.
  async reconnect() {
    if (!this.device) throw new Error('No device to reconnect to. Use Connect.');
    await this._open();
  }

  disconnect() {
    this._userDisconnect = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this._setState('disconnected');
  }

  async read(key) {
    try {
      const entry = this._get(key);
      if (!entry.info.props.read) throw new Error('Characteristic is not readable');
      return await this._run(async () => {
        const { c } = this._get(key);
        const buffered = [];
        this._reads.set(key, buffered);
        let bytes;
        try {
          bytes = toBytes(await c.readValue());
        } finally {
          this._reads.delete(key);
        }
        // Chrome also fires characteristicvaluechanged for a read result; drop that echo, keep real notifications.
        const echo = buffered.findIndex(b => bytesEqual(b.bytes, bytes));
        if (echo >= 0) buffered.splice(echo, 1);
        this._log({ dir: 'R', key, bytes });
        this._emit('value', { key, bytes, dir: 'R' });
        for (const b of buffered) this._notified(key, b.bytes, b.t);
        return bytes;
      });
    } catch (e) {
      throw this._fail(e, key, 'read');
    }
  }

  // mode: 'auto' (from characteristic properties) | 'with' | 'without' (response); note: extra log text
  async write(key, bytes, { mode = 'auto', note } = {}) {
    const data = Uint8Array.from(bytes);
    try {
      if (isGenericAccess(key) && !this.allowGenericAccessWrites) {
        throw new Error('Blocked: writes to Generic Access (0x1800) are disabled in Settings.');
      }
      const { props } = this._get(key).info;
      const without = mode === 'without' || (mode === 'auto' && props.writeWithoutResponse && !props.write);
      await this._run(async () => {
        const { c } = this._get(key);
        if (without) await c.writeValueWithoutResponse(data);
        else if (c.writeValueWithResponse) await c.writeValueWithResponse(data);
        else await c.writeValue(data);
        this._log({ dir: 'W', key, bytes: data, mode: without ? 'no-resp' : 'resp', text: note });
      });
    } catch (e) {
      throw this._fail(e, key, `write ${toHex(data)}`);
    }
  }

  // For rapid input (sliders, auto-send): only the newest command per slot is kept and writes
  // are paced to maxWritesPerSecond, so the queue never fills with stale commands.
  writeLatest(slot, key, bytes, opts) {
    this._latest.set(slot, { key, bytes, opts });
    this._pump();
  }

  async subscribe(key) {
    try {
      const { info } = this._get(key);
      if (!info.props.notify && !info.props.indicate) throw new Error('Characteristic does not support notify/indicate');
      await this._run(async () => {
        const entry = this._get(key);
        if (!entry.handler) {
          entry.handler = ev => this._onValue(key, ev.target.value);
          entry.c.addEventListener('characteristicvaluechanged', entry.handler);
        }
        try {
          await entry.c.startNotifications();
        } catch (e) {
          entry.c.removeEventListener('characteristicvaluechanged', entry.handler);
          entry.handler = null;
          throw e;
        }
      });
      this.subscribed.add(key);
      this._log({ dir: 'I', key, text: 'Subscribed' });
      this._emit('subscriptions', this.subscribed);
    } catch (e) {
      throw this._fail(e, key, 'subscribe');
    }
  }

  async unsubscribe(key) {
    this.subscribed.delete(key);
    this._emit('subscriptions', this.subscribed);
    const entry = this.chars.get(key);
    if (!entry?.handler) return;
    try {
      await this._run(async () => {
        entry.c.removeEventListener('characteristicvaluechanged', entry.handler);
        entry.handler = null;
        if (this.connected) await entry.c.stopNotifications();
      });
      this._log({ dir: 'I', key, text: 'Unsubscribed' });
    } catch (e) {
      throw this._fail(e, key, 'unsubscribe');
    }
  }

  async subscribeAll() {
    let n = 0;
    for (const [key, { info }] of this.chars) {
      if ((info.props.notify || info.props.indicate) && !this.subscribed.has(key)) {
        await this.subscribe(key).then(() => n++, () => {});
      }
    }
    return n;
  }

  // Drops queued (not yet sent) operations and coalesced commands, e.g. before sending a stop packet.
  clearPending(reason = 'Dropped') {
    for (const job of this._queue.splice(0)) job.reject(abortError(reason));
    this._latest.clear();
  }

  info(text, key) {
    this._log({ dir: 'I', key, text });
  }

  // --- internals ---

  _attach(device) {
    if (this.device === device) return;
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnected);
    this.device = device;
    this.subscribed.clear();
    device.addEventListener('gattserverdisconnected', this._onDisconnected);
  }

  async _open() {
    this._userDisconnect = false;
    this._setState('connecting');
    try {
      this.server = await this.device.gatt.connect();
      this._log({ dir: 'I', text: `Connected to ${this.device.name || this.device.id || 'device'}` });
      await this._discover();
      this._setState('connected');
      for (const key of [...this.subscribed]) {
        if (this.chars.has(key)) await this.subscribe(key).catch(() => {});
        else this.subscribed.delete(key);
      }
    } catch (e) {
      this._setState(this.connected ? 'connected' : 'disconnected');
      throw this._fail(e, undefined, 'connect');
    }
  }

  async _discover() {
    await this._run(async () => {
      const services = await this.server.getPrimaryServices();
      this.services = [];
      this.chars.clear();
      for (const s of services) {
        const svc = { uuid: s.uuid, chars: [] };
        let list = [];
        try {
          list = await s.getCharacteristics();
        } catch (e) {
          if (e.name !== 'NotFoundError') this._log({ dir: 'E', text: `getCharacteristics ${s.uuid}: ${e.message}` });
        }
        for (const c of list) {
          let key = `${s.uuid}/${c.uuid}`;
          for (let n = 2; this.chars.has(key); n++) key = `${s.uuid}/${c.uuid}#${n}`;
          const props = {};
          for (const p of PROP_NAMES) props[p] = !!c.properties[p];
          const info = { key, uuid: c.uuid, serviceUuid: s.uuid, props };
          this.chars.set(key, { c, info, handler: null });
          svc.chars.push(info);
        }
        this.services.push(svc);
      }
    });
    this._log({ dir: 'I', text: `Discovered ${this.services.length} services, ${this.chars.size} characteristics` });
    this._emit('gatt', this.services);
  }

  // Chrome rejects overlapping GATT operations ("GATT operation already in progress"),
  // so every operation goes through this single FIFO queue.
  _run(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._busy) return;
    this._busy = true;
    while (this._queue.length) {
      const job = this._queue.shift();
      try {
        job.resolve(await job.fn());
      } catch (e) {
        job.reject(e);
      }
    }
    this._busy = false;
  }

  _pump() {
    if (this._latestTimer || this._latestBusy || !this._latest.size) return;
    const interval = 1000 / Math.max(1, this.maxWritesPerSecond);
    const wait = Math.max(0, this._lastLatestAt + interval - now());
    this._latestTimer = setTimeout(async () => {
      this._latestTimer = null;
      const next = this._latest.entries().next().value;
      if (!next) return;
      const [slot, cmd] = next;
      this._latest.delete(slot);
      this._latestBusy = true;
      this._lastLatestAt = now();
      try {
        await this.write(cmd.key, cmd.bytes, cmd.opts);
      } catch {
        // already logged and emitted by write()
      } finally {
        this._latestBusy = false;
        this._pump();
      }
    }, wait);
  }

  _get(key) {
    if (!this.connected) throw Object.assign(new Error('Not connected'), { name: 'NetworkError' });
    const entry = this.chars.get(key);
    if (!entry) throw Object.assign(new Error(`Characteristic not found: ${key}`), { name: 'NotFoundError' });
    return entry;
  }

  _onValue(key, view) {
    const bytes = toBytes(view);
    const t = now();
    const pendingRead = this._reads.get(key);
    if (pendingRead) pendingRead.push({ bytes, t });
    else this._notified(key, bytes, t);
  }

  _notified(key, bytes, t) {
    this._log({ dir: 'N', key, bytes, t });
    this._emit('value', { key, bytes, dir: 'N' });
  }

  _onDisconnected() {
    const user = this._userDisconnect;
    this._userDisconnect = false;
    this.clearPending('Disconnected');
    this.chars.clear();
    this.server = null;
    this._log({ dir: user ? 'I' : 'E', text: user ? 'Disconnected' : 'Connection lost' });
    this._setState('disconnected');
    this._emit('disconnected', { user });
  }

  _fail(e, key, what) {
    const err = friendlyError(e);
    if (err.name !== 'AbortError') {
      this._log({ dir: 'E', key, text: `${what} failed: ${err.message}` });
      this._emit('error', err);
    }
    return err;
  }

  _log(entry) {
    entry.t ??= now();
    this._emit('log', entry);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', state);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
