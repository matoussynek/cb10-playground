# CB10 Web Controller: project plan

A static website that controls a cheap Lego-WeDo-style BLE motor hub ("CB10") directly from the browser via **Web Bluetooth**. No backend, no build step, no vendor app.

The BLE protocol of the hub is **not documented anywhere and not yet known**. The project therefore starts with a probing tool (Phase 1) and only then becomes a controller (Phases 2-4). Do not invent protocol details. Anything marked UNKNOWN must be discovered with the human and recorded in `PROTOCOL.md`.

---

## 1. Goals and constraints

- Single static site, hostable on GitHub Pages or `python3 -m http.server`.
- Vanilla HTML/CSS/JS with ES modules. No frameworks, no bundler, no npm dependencies for the site itself.
- Works on Chrome/Edge (Android and desktop). Web Bluetooth does not exist in Safari, Firefox or any iOS browser; show a clear message there (optionally mention the Bluefy browser on iOS).
- Mobile-first layout (the human will mostly use a phone/tablet next to the robot), dark theme, large touch targets.
- The human deliberately does **not** want to install or reverse-engineer the vendor app, so the protocol must be discovered by black-box probing from this site.
- The robot is a toy, but motors can stall or run away: always provide a prominent **STOP ALL** and stop motors on disconnect, tab hide, or page unload.

Out of scope: the vendor app/APK, firmware changes, anything on the IR remote side.

---

## 2. What is already known (from nRF Connect and the manual)

### Hardware
- Hub: "CB10", a small receiver/controller. **Two motor ports (A and B). No sensor inputs.** There is a 4-position channel switch (IR channels 1-4) used with the handheld IR remote.
- Powered by 6x AA in a battery station. The hub also has Bluetooth LE for the phone app.
- The official app ("SmartBlocks Pro", version 1.1.2) has two modes, which are the feature targets for this project:
  - **Control**: choose channel 1/2/3/4; Motor A and Motor B each have up/down buttons and a "switching" toggle; a second panel has joystick-style dials for exact speed and a "One click Restore" reset. A gauge shows values like 0 and 50.
  - **Program**: block editor with categories Event, Motion, Control, Acousto-Optic, Operation. Example blocks: "Perform gear [1Port]" (hat block), "Port A [Clockwise] run [5] s delay [0] s", "Play tone [A5]", "Play music song [2]", "Repeat execution [1] time". Sounds play from the *phone*, so the program logic very probably runs in the app and just sends motor commands over BLE. Assume this until disproven.

### BLE (observed with nRF Connect)
- Advertised name looks like `CB10-2023AAAA1514` (so: name prefix `CB10`). Connects without bonding ("NOT BONDED"); no pairing needed.
- GATT services:
  - `0x1800` Generic Access: Device Name (0x2A00) and Appearance (0x2A01) are oddly *writable*. **Never write to these.**
  - `0x1801` Generic Attribute (Service Changed, indicate).
  - `0xFFF0` (vendor-generic):
    - `0xFFF1`: NOTIFY, READ
    - `0xFFF2`: WRITE
  - `00005247-0001-1000-8000-00805f9b34fb` (custom; 0x5247 is ASCII "RG"):
    - `00005248-0002-1000-8000-00805f9b34fb`: WRITE
    - `00005249-0003-1000-8000-00805f9b34fb`: NOTIFY, READ
    - `0000524a-0003-1000-8000-00805f9b34fb`: NOTIFY
    - (the screenshot was cut off below this; there may be more characteristics. The probe tool will enumerate everything.)
- Which service carries motor commands (`FFF0` vs `5247`) is UNKNOWN. Possibly one is a leftover generic module profile and the other the real protocol.
- Packet format, framing, checksum, speed range and the role of the channel field are all UNKNOWN. No public documentation was found.

---

## 3. Architecture

```
index.html
css/style.css
js/
  main.js        # wires UI to modules, feature detection, app state
  ble.js         # Web Bluetooth wrapper: connect, discover, read, write, notify, serialised queue
  mock.js        # fake BLE device for development without hardware (?mock=1)
  protocol.js    # CB10 protocol encode/decode, pure functions, filled in as discovered
  probe.js       # Phase 1 UI logic (explorer, hex sender, byte sweeper, log)
  control.js     # Phase 3 control panel
  program.js     # Phase 4 sequencer and tone player
tests/
  protocol.test.js   # node --test, no dependencies
PROTOCOL.md      # living document of discovered protocol facts
```

Serve over `http://localhost` or HTTPS. ES modules need an HTTP server (not `file://`); document `python3 -m http.server 8000` in a short README.

### `ble.js` requirements
- `requestDevice({ filters: [{ namePrefix: 'CB10' }], optionalServices: [0xfff0, '00005247-0001-1000-8000-00805f9b34fb'] })`. **Optional services must be declared up front or Chrome blocks access.** Provide a toggle for `acceptAllDevices: true` as fallback, since the name may be missing from the advertisement packet; if used, `optionalServices` must still be listed.
- Connect must be triggered by a user click.
- After connecting, enumerate all primary services and all characteristics, with their properties (read, write, writeWithoutResponse, notify, indicate). Expose this as data for the UI.
- Use `characteristic.properties` to choose `writeValueWithResponse` vs `writeValueWithoutResponse`; allow manual override in the probe tool.
- **Serialise all GATT operations** through one promise queue. Chrome throws "GATT operation already in progress" otherwise. For rapid control input, coalesce: keep only the latest pending command per motor and drop stale ones, targeting at most about 20 writes per second (configurable).
- Handle `gattserverdisconnected`: update UI, offer one-click reconnect (reuse the same device object via `device.gatt.connect()`), and re-subscribe notifications.
- Map errors to human-readable messages (user cancelled picker, GATT disconnected, characteristic not found, permission/secure-context problems, Bluetooth off).
- Guard: refuse writes to the `0x1800` service characteristics unless an explicit "I know what I'm doing" toggle is on (off by default).

### `mock.js`
Provide a fake device with the same GATT shape as above, which logs writes and emits plausible notifications on a timer, so that the UI and tests can be developed without hardware. Enable with `?mock=1`. Clearly label the UI "MOCK MODE" when active. Real hardware testing can only be done by the human.

---

## 4. Phases

Do the phases in order. **Stop after Phase 1 and ask the human to run the discovery session (section 5) before building Phase 2+.**

### Phase 1: Probe console (the important one)
A working tool for exploring the hub from a phone.

Features:
1. **Connect / disconnect / reconnect** buttons and a status badge.
2. **GATT explorer**: tree of services > characteristics with UUID, properties, and per-characteristic actions (Read, Subscribe/Unsubscribe, Write).
3. **Subscribe all**: one button to enable notifications on every notify/indicate characteristic.
4. **Live log**: timestamped entries (ms resolution) for every read, write and notification, showing direction, characteristic UUID, and the value as **hex, decimal bytes, and ASCII**. Filter by characteristic, pause, clear, copy to clipboard, download as `.txt`/`.json`.
5. **Hex sender**: choose a writable characteristic, type hex (`01 02 ff`, `0x01,0x02`, or `0102ff`; tolerate whitespace), choose with/without response, send. Keep history; click a history item to resend.
6. **Byte-grid packet builder**: N byte cells (N adjustable, 1-20), each editable in hex with +/-1 and +/-16 buttons, "send" and "auto-send on change" toggle (off by default). This is the main tool for finding which byte means what.
7. **Byte sweeper** (guarded): pick a packet template, one byte index, start/end/step and delay (default 300 ms, minimum 100 ms). Show progress, an always-visible Abort, and log each value sent. Hard cap on sweep length per run and a confirmation before starting.
8. **Panic stop**: a user-definable "stop packet" (hex plus target characteristic) that is sent on one tap, on disconnect attempts, and on page hide. Empty until the human sets it.
9. **Notes field** per session that is saved with the log export (so findings can be pasted into `PROTOCOL.md`).

Acceptance: against the mock, every feature works; against real hardware the human can connect, see all services, and see notifications.

### Phase 2: Protocol layer (blocked until discovery is done)
Implement `protocol.js` **only from facts recorded in `PROTOCOL.md`**.

- Pure functions: `encodeSetMotor({ channel, motor, speed })`, `encodeStopAll(channel)`, `encodeSetChannel(...)` (only if the protocol has such a command), `decodeNotification(bytes)`. Return `Uint8Array`/plain objects; no BLE calls inside.
- A single `PROTOCOL` config object at the top holding service/characteristic UUIDs, byte layout constants, speed range, checksum function if any.
- Unit tests in `tests/protocol.test.js` using `node --test`, built from the verified example packets in `PROTOCOL.md`.
- If a checksum or header turns out to exist, document the algorithm in `PROTOCOL.md` and test it against captured examples.

### Phase 3: Control panel
Mirror the official Control mode, but better.

- Channel selector 1-4 (only if the protocol uses a channel; otherwise hide).
- Two motor panels (A and B): vertical slider from -100 to +100 (mapped to the real protocol range), plus **hold-to-run up/down buttons** using pointer events (`pointerdown`/`pointerup`/`pointercancel`/`pointerleave`) so a lifted finger always stops the motor.
- Per-motor **invert direction** toggle (the manual's "switching" toggle) and **max speed cap**, saved in `localStorage` (wrapped in try/catch).
- **STOP ALL** large button; automatic stop on `visibilitychange` (hidden), `pagehide`, and BLE disconnect.
- Command throttling via the queue/coalescing from `ble.js`.
- Show battery/status if `decodeNotification` can provide it; otherwise show raw last notification in a collapsible debug area.
- Keyboard support on desktop (e.g. W/S for A, I/K for B, space = stop).

### Phase 4: Program editor
Recreate the official Program mode in a simple form. Because the logic runs in the browser, only the Phase 2 primitives are needed.

- Linear list of steps with add/remove/reorder (drag handles or up/down buttons). Step types:
  - Run motor: motor A/B/both, direction or signed speed, duration (s), delay after (s)
  - Wait (s)
  - Repeat N times (container block, nesting depth 1-2 is enough)
  - Play tone: note name (e.g. A5) and duration, via the Web Audio API oscillator
  - Play song: small built-in set of note sequences ("song 1", "song 2", ...)
  - Stop all
- Run/Stop buttons; the executor is an async function using abortable sleeps (`AbortController`). **Stop must immediately send stop-all and halt the sequence.**
- Request a **Screen Wake Lock** while running (`navigator.wakeLock`) and tell the user the page must stay in the foreground (browsers throttle/suspend background tabs, which would stall the robot).
- Save/load programs in `localStorage` and import/export as JSON.
- Highlight the currently running step.

---

## 5. Discovery session for the human (do this after Phase 1)

Guidelines for probing, to be copied into the README and followed by the human:

1. Connect with the motors plugged into ports A and/or B, robot off the table or wheels lifted, fresh batteries in the power station.
2. **Listen first.** Subscribe all, wait 30 s, press nothing. Note what arrives on `FFF1`, `5249`, `524a` and any periodic frames. Read `FFF1` and `5249`. Record lengths and constant bytes; a constant first byte is probably a header, the second possibly a length.
3. **Then write, carefully.** Start with the characteristics most likely to be commands: `FFF2` and `00005248-0002-...`. Try short packets of increasing length (1, 2, 3, ... bytes) with low values. Note any notification reply and any motor motion. A device that silently ignores malformed packets is normal; a notification reply is the best signal.
4. Change **one byte at a time** with the byte-grid builder. Record which index changes the motor (A vs B), the direction, the speed, and the channel. If almost every change makes the hub ignore the packet, suspect a header or checksum and look at how the replies are framed.
5. Candidate shapes to test (all unverified guesses, not facts): a fixed frame such as `[header][command][channel][A][B][checksum]`; a length-prefixed frame; or a very short `[channel][motor][speed]` packet.
6. Do not write to the Device Name/Appearance characteristics. Avoid long payloads (over 20 bytes) unless a reply suggests a longer frame.
7. Whenever something works, copy the exact hex from the log into `PROTOCOL.md` under "Verified examples", with a one-line description (e.g. "motor A forward, speed 50, channel 1"), plus "Unverified guesses" separately.
8. Define the panic-stop packet as soon as any "stop"/zero-speed packet is known.

Expected result: a table of verified packets (set motor A speed X, set motor B speed X, stop, channel change), the speed range and direction encoding, and whether the hub needs a keep-alive or re-send to keep running (some hubs stop after a timeout; the official app's "run 5 s" blocks suggest timed runs may be handled either by the hub or by repeated commands: find out which).

`PROTOCOL.md` template to create in Phase 1:

```
# CB10 protocol (living document)
## Transport
Service/characteristic UUIDs used, write type, MTU observations.
## Frames
Header, length, checksum, byte-by-byte layout.
## Verified examples
| Action | Characteristic | Hex | Notes |
## Notifications
| Characteristic | Example hex | Meaning |
## Unverified guesses
## Open questions
```

---

## 6. Quality, UX and robustness

- Feature-detect `navigator.bluetooth`; if absent, show a full-screen explanation with supported browsers.
- Detect insecure context (`window.isSecureContext`) and explain the HTTPS/localhost requirement.
- Always show connection state, selected device name, and last error.
- No external scripts, fonts or CDNs; everything is self-contained so it works offline once loaded (a simple service worker is optional and low priority).
- Accessible: labelled buttons, sufficient contrast, no reliance on colour alone, 44 px minimum touch targets.
- Responsive from 360 px wide up; the probe console must be usable on a phone (collapsible sections, monospace log with horizontal scroll).
- Keep code small and commented where Web Bluetooth quirks matter (serialised queue, optionalServices, user-gesture requirement).

## 7. Definition of done

- Phase 1: complete and verified on the mock; human has run a discovery session on real hardware.
- `PROTOCOL.md` filled in with verified packets.
- Phases 2-4 implemented, tests pass (`node --test`), the control panel moves both motors on real hardware, and STOP ALL / disconnect / tab-hide reliably stop them.
- A short README with run instructions, browser support notes, and the safety notes above.

## 8. Instructions to the implementing agent

- Build Phase 1 first and then **pause and ask the human** to do the hardware discovery; do not guess packet formats.
- Prefer small, readable modules over cleverness; no dependencies.
- You cannot test Web Bluetooth against real hardware. Use the mock for development and be explicit about what is untested on hardware.
- When something in this plan conflicts with what the hardware actually does, trust the hardware, update `PROTOCOL.md`, and tell the human.
