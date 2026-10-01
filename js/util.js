// Pure helpers (no DOM, no BLE) so they can be unit-tested with `node --test`.

// Accepts "01 02 ff", "0x01,0x02", "0102ff", "1 2 ff", "01:02-ff". A single digit is one byte.
export function parseHex(text) {
  const out = [];
  const tokens = String(text).trim().split(/[\s,;:-]+/).filter(Boolean);
  for (const raw of tokens) {
    let t = raw.toLowerCase();
    if (t.startsWith('0x')) t = t.slice(2);
    if (!t || !/^[0-9a-f]+$/.test(t)) throw new Error(`Not hex: "${raw}"`);
    if (t.length === 1) {
      out.push(parseInt(t, 16));
      continue;
    }
    if (t.length % 2) throw new Error(`Odd number of hex digits in "${raw}"`);
    for (let i = 0; i < t.length; i += 2) out.push(parseInt(t.slice(i, i + 2), 16));
  }
  return Uint8Array.from(out);
}

export const hexByte = b => b.toString(16).padStart(2, '0').toUpperCase();
export const toHex = bytes => Array.from(bytes, hexByte).join(' ');
export const toDec = bytes => Array.from(bytes).join(' ');
export const toAscii = bytes =>
  Array.from(bytes, b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');

// DataView buffers from Web Bluetooth may be reused by the browser, so always copy.
export function toBytes(view) {
  if (!view) return new Uint8Array(0);
  if (view instanceof ArrayBuffer) return new Uint8Array(view.slice(0));
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const BASE = '-0000-1000-8000-00805f9b34fb';
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function canonicalUUID(uuid) {
  if (typeof uuid === 'number') return uuid.toString(16).padStart(8, '0') + BASE;
  let s = String(uuid).trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  if (/^([0-9a-f]{4}|[0-9a-f]{8})$/.test(s)) return s.padStart(8, '0') + BASE;
  if (FULL_UUID.test(s)) return s;
  throw new Error(`Invalid UUID: "${uuid}"`);
}

// "FFF1" for standard-base UUIDs, "5248…" for custom ones.
export function shortUUID(uuid) {
  const s = canonicalUUID(uuid);
  const std = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(s);
  if (std) return std[1].toUpperCase();
  return (s.startsWith('0000') ? s.slice(4, 8) : s.slice(0, 8)).toUpperCase() + '…';
}

const NAMES = {
  '1800': 'Generic Access', '1801': 'Generic Attribute', '180A': 'Device Information',
  '180F': 'Battery', '2A00': 'Device Name', '2A01': 'Appearance', '2A04': 'Conn. Params',
  '2A05': 'Service Changed', '2A19': 'Battery Level', '2A24': 'Model', '2A26': 'Firmware',
  '2A27': 'Hardware Rev', '2A28': 'Software Rev', '2A29': 'Manufacturer', '2A50': 'PnP ID',
  '2AA6': 'Central Addr. Res.',
};

export function uuidLabel(uuid) {
  const short = shortUUID(uuid);
  return NAMES[short] ? `${short} ${NAMES[short]}` : short;
}

// Characteristic keys are "<serviceUuid>/<charUuid>[#n]" (n only for duplicate UUIDs).
export function keyLabel(key) {
  if (!key) return '';
  const [svc, rest] = key.split('/');
  const [chr, dup] = rest.split('#');
  return `${shortUUID(svc)}/${uuidLabel(chr)}${dup ? '#' + dup : ''}`;
}

export const now = () => performance.timeOrigin + performance.now();

export function formatTime(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export const SWEEP_MAX = 128;

// Values from start to end inclusive (either direction), step > 0. Throws if invalid or too long.
export function sweepValues(start, end, step) {
  for (const [name, v] of [['start', start], ['end', end]]) {
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`${name} must be 0-255`);
  }
  if (!Number.isInteger(step) || step < 1 || step > 255) throw new Error('step must be 1-255');
  const dir = end >= start ? 1 : -1;
  const out = [];
  for (let v = start; dir > 0 ? v <= end : v >= end; v += dir * step) out.push(v);
  if (out.length > SWEEP_MAX) throw new Error(`Sweep of ${out.length} values exceeds the cap of ${SWEEP_MAX} per run`);
  return out;
}

// Parses decimal ("16") or hex ("0x10") into an integer, or NaN.
export function parseIntLoose(text) {
  const s = String(text).trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NaN;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

// localStorage can throw (private mode, blocked site data), so never let it break the page.
export function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable; settings just won't persist
  }
}
