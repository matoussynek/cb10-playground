// CB10 protocol: pure encode/decode functions, no BLE calls. Source of every value: docs/PROTOCOL.md.

export const PROTOCOL = {
  namePrefix: 'CB10',

  services: {
    fff0: '0000fff0-0000-1000-8000-00805f9b34fb',
    rg: '00005247-0001-1000-8000-00805f9b34fb', // not used by the official app
  },
  characteristics: {
    fff1: '0000fff1-0000-1000-8000-00805f9b34fb', // replies (notify)
    fff2: '0000fff2-0000-1000-8000-00805f9b34fb', // commands (write with response)
    rg5248: '00005248-0002-1000-8000-00805f9b34fb',
    rg5249: '00005249-0003-1000-8000-00805f9b34fb',
    rg524a: '0000524a-0003-1000-8000-00805f9b34fb',
  },

  // Chrome only exposes services listed here (or in the filters), so list everything worth seeing.
  optionalServices: [
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '00005247-0001-1000-8000-00805f9b34fb',
    '00001800-0000-1000-8000-00805f9b34fb',
    '00001801-0000-1000-8000-00805f9b34fb',
    '0000180a-0000-1000-8000-00805f9b34fb',
    '0000180f-0000-1000-8000-00805f9b34fb',
  ],

  // Frame: [header] [data …] [sum(data) & 0xFF] [END]
  end: 0xdd,
  headerBase: 0x80, // command header = headerBase + channel - 1
  replyHeader: 0x88,
  channels: 4,
  motorPrefix: 0x80, // first data byte of a motor command
  portMarker: 0xf0, // precedes the speed of a used port
  unused: 0xff, // marker and speed of an unused port
  ports: 6, // the frame has room for six ports; the CB10 has two
  // Frame port index per hub socket label. The hub's printed labels are swapped relative to the app.
  portIndex: { B: 0, A: 1 },
  speedStop: 0x80,
  // The app keeps commands at least this far apart.
  minCommandIntervalMs: 50,
};

export const CHANNELS = [1, 2, 3, 4];
export const MOTORS = ['A', 'B'];

export function checksum(data) {
  let sum = 0;
  for (const b of data) sum += b;
  return sum & 0xff;
}

export function frame(header, data) {
  return Uint8Array.from([header, ...data, checksum(data), PROTOCOL.end]);
}

// -100..100 → speed byte, as the app maps its dial: 0 = stop, ±1..99 = 0x80 ± n, ±100 = 0xFF / 0x00.
// Positive is the app's default "forward" (byte above 0x80).
export function speedByte(speed) {
  if (!Number.isFinite(speed)) throw new RangeError(`Invalid speed: ${speed}`);
  const s = Math.round(Math.max(-100, Math.min(100, speed)));
  if (s >= 100) return 0xff;
  if (s <= -100) return 0x00;
  return PROTOCOL.speedStop + s;
}

function checkChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new RangeError(`Channel must be 1-4, got ${channel}`);
}

// One frame always sets both motors.
export function encodeMotors({ channel, A = 0, B = 0 }) {
  checkChannel(channel);
  const pairs = Array.from({ length: PROTOCOL.ports }, () => [PROTOCOL.unused, PROTOCOL.unused]);
  pairs[PROTOCOL.portIndex.A] = [PROTOCOL.portMarker, speedByte(A)];
  pairs[PROTOCOL.portIndex.B] = [PROTOCOL.portMarker, speedByte(B)];
  return frame(PROTOCOL.headerBase + channel - 1, [PROTOCOL.motorPrefix, ...pairs.flat()]);
}

export const encodeStop = channel => encodeMotors({ channel, A: 0, B: 0 });

// Stop frames for every channel, as the app sends them; `first` goes out first.
export function encodeStopAll(first = 1) {
  checkChannel(first);
  return [first, ...CHANNELS.filter(c => c !== first)].map(encodeStop);
}

// Replies seen so far: `88 <ch> 00 00 00 00 <sum> DD` after a command for the hub's own channel
// (the app's "channel found" signal), and `88 80 FF FF FF FF 7C DD` after anything else.
export function decodeNotification(bytes) {
  const b = Array.from(bytes);
  if (b.length < 3 || b.at(-1) !== PROTOCOL.end) return { valid: false, raw: b };
  const header = b[0];
  const data = b.slice(1, -2);
  const out = { valid: checksum(data) === b.at(-2), header, data };
  if (header === PROTOCOL.replyHeader && data.length === 5) {
    const ch = data[0] - PROTOCOL.headerBase + 1;
    out.channel = CHANNELS.includes(ch) ? ch : null;
    const rest = data.slice(1);
    out.status = rest.every(x => x === 0) ? 'ok' : rest.every(x => x === 0xff) ? 'ignored' : 'unknown';
  }
  return out;
}
