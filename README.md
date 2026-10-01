# CB10 Web Controller

A static site that talks to the "CB10" Lego-WeDo-style motor hub straight from the browser via Web Bluetooth. No backend, no build step, no dependencies.

Three screens, picked from the dock at the bottom:

- **Drive**: a big ▲ / ▼ key and a slider for each motor (A blue, B green), plus STOP.
- **Code**: Scratch-style blocks (motor, stop motors, wait, repeat, note, song). Tap a coloured block to add it; tap a block in your program to move, copy or delete it. A selected *repeat* takes new blocks inside it. ▶ runs the whole program, the green ▶ on a selected block runs just that block, ■ stops.

The button left of Connect switches to full screen (where the browser supports it).
- **Settings**: hub and channel, per-motor tuning (spin the other way, top speed, dead zone), connection options, and under **Developer** the probe console used to discover the protocol.

**Connecting:** tap the button at the top. Chrome asks you to pick the hub the first time. After that the button reconnects without the picker. Dropped connections are retried automatically, and where Chrome remembers the hub from a previous visit, the page connects by itself when it opens.

The protocol is documented in [docs/PROTOCOL.md](docs/PROTOCOL.md). It was worked out by probing and then by decompiling the official SmartBlocks Pro app.

## Run

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. ES modules don't load from `file://`, and Web Bluetooth needs a secure context: `localhost` or HTTPS. A LAN address such as `http://192.168.1.10:8000` is **not** secure, so to use a phone either:

- use the deployed site (see *Deploy* below), or
- on Android, connect the phone over USB and use Chrome's port forwarding (`chrome://inspect` → Port forwarding, `8000 → localhost:8000`), then open `http://localhost:8000` on the phone.

**Mock mode:** open <http://localhost:8000/?mock=1> to use a pretend hub (add `&known=1` to simulate a remembered hub) that answers like the real one (same GATT layout, reply frames and channel check). A purple "PRETEND HUB" banner shows the motor speeds it received.

Tests: `npm test` (runs `node --test`, Node 20+; no dependencies to install).

## Project structure

```
index.html, css/, js/      the site (static, no build step); js/ holds ES modules:
  main.js                  views, connection flow, safety hooks
  ble.js / mock.js         Web Bluetooth wrapper and the pretend hub
  protocol.js              CB10 frame encoder/decoder
  control.js / program.js  Drive screen and Code (block) editor
  probe.js                 developer probe console
tests/                     node --test unit tests
docs/PROTOCOL.md           everything known about the hub's protocol
docs/PLAN.md               the original project plan
.github/workflows/         test + GitHub Pages deployment
```

## Deploy (GitHub Pages)

Live: <https://matoussynek.github.io/cb10-playground/>

Every push to `master` runs the tests and, if they pass, publishes `index.html`, `css/` and `js/` to GitHub Pages. Pull requests only run the tests. Pages is served over HTTPS, which Web Bluetooth requires, so the live URL works on a phone.

One-time setup on GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**. A run can also be started by hand from the Actions tab (*Test and deploy to GitHub Pages* → *Run workflow*).

## Browser support

Chrome or Edge on Android, Windows, macOS, ChromeOS. On Linux, Web Bluetooth may need to be enabled in `chrome://flags`. Safari, Firefox and all iOS browsers have no Web Bluetooth; on iPhone/iPad the third-party Bluefy browser may work.

On Android, Bluetooth **and** Location must be on for the device picker to find anything.

## Safety

- The red **STOP** in the header (and **STOP** on the Drive screen, or Space) halts a running program or sweep, drops queued commands, and sends a stop frame on all four channels, starting with the selected one.
- The same happens before Disconnect and whenever the page is hidden or closed. Hold buttons stop the motor when your finger lifts or slides off. This is best effort: once the connection is gone, nothing can be sent, and the hub probably keeps running its last command. Keep the hub's power switch within reach.
- Programs only run while the page is in the foreground; hiding the page stops the program and the motors.
- On connect, the app sends one stop frame per channel to find the hub's channel (like the official app). Turn this off in Settings if you don't want it.
- Lift the wheels while probing: unknown packets can start a motor at full speed.
- Writes to the Generic Access service (Device Name / Appearance) are blocked unless enabled in Settings. Leave them blocked.

## Hub notes

- The hub's printed socket labels are swapped compared with the official app; this site uses the labels printed on the hub.
- Speed is −100…100 %. The hub byte is `0x80 ± n`, and ±100 maps to `0xFF` / `0x00`, as in the official app.
- Motors stall below about 20 % (and need about 24 % to start from standstill). Each motor's **Dead zone** setting (default 20 %) spreads 1…100 % over dead zone…max speed, so every slider position turns the motor. Set it to 0 to send raw values.

## Probe console features (Settings → Developer)

- **Connection:** connect by name prefix (`CB10`), or "Show all devices" if the hub doesn't advertise its name. Reconnect reuses the same device without the picker and re-subscribes notifications. Extra service UUIDs can be added if the hub turns out to have more services (Chrome hides services that aren't declared up front).
- **GATT explorer:** every service and characteristic with properties, last value, Read / Subscribe / Write. "Subscribe all" and "Read all".
- **Hex sender:** accepts `01 02 ff`, `0x01,0x02`, `0102ff`. Write type is auto (from properties) or forced. History; tap an entry to resend it.
- **Byte grid:** 1-20 bytes with ±1/±16 buttons; optional auto-send on change (rate-limited, newest value wins).
- **Byte sweeper:** varies one byte of a template over a range with a delay (min 100 ms, max 128 packets per run), with confirmation and an always-visible Abort bar.
- **Live log:** ms timestamps, hex / decimal / ASCII, filter by characteristic, pause, copy, download as `.txt` or `.json` (includes your session notes and the GATT layout).

## Discovery session

Done (see docs/PROTOCOL.md); kept for reference. Follow these steps on real hardware and record results in [docs/PROTOCOL.md](docs/PROTOCOL.md).

1. Connect with the motors plugged into ports A and/or B, robot off the table or wheels lifted, fresh batteries in the power station.
2. **Listen first.** Subscribe all, wait 30 s, press nothing. Note what arrives on `FFF1`, `5249`, `524a` and any periodic frames. Read `FFF1` and `5249`. Record lengths and constant bytes; a constant first byte is probably a header, the second possibly a length.
3. **Then write, carefully.** Start with the characteristics most likely to be commands: `FFF2` and `00005248-0002-…`. Try short packets of increasing length (1, 2, 3, … bytes) with low values. Note any notification reply and any motor motion. A device that silently ignores malformed packets is normal; a notification reply is the best signal.
4. Change **one byte at a time** with the byte grid. Record which index changes the motor (A vs B), the direction, the speed, and the channel. If almost every change makes the hub ignore the packet, suspect a header or checksum and look at how the replies are framed.
5. Candidate shapes to test (all unverified guesses, not facts): a fixed frame such as `[header][command][channel][A][B][checksum]`; a length-prefixed frame; or a very short `[channel][motor][speed]` packet.
6. Do not write to the Device Name/Appearance characteristics. Avoid long payloads (over 20 bytes) unless a reply suggests a longer frame.
7. Whenever something works, copy the exact hex from the log into `docs/PROTOCOL.md` under "Verified examples", with a one-line description (e.g. "motor A forward, speed 50, channel 1"), plus "Unverified guesses" separately.
8. Define the panic-stop packet as soon as any "stop"/zero-speed packet is known.

Goal: a table of verified packets (set motor A speed X, set motor B speed X, stop, channel change), the speed range and direction encoding, and whether the hub needs a keep-alive or re-sends to keep running (find out whether a motor keeps running after a single command, and for how long).

When done, export the log as `.json` and share it together with your docs/PROTOCOL.md notes.
