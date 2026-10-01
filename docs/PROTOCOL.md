# CB10 protocol (living document)

Only record what was observed on real hardware. Keep guesses in "Unverified guesses".

## Transport

Confirmed from the probe console (Chrome, session 1):

- Device name as seen by Chrome: `CB10- 2023AAAA1514` (with a space after the dash). The `CB10` prefix filter matches it.
- Chrome exposes exactly 2 services and 5 characteristics: `FFF0` (`FFF1`, `FFF2`) and `5247…` (`5248…`, `5249…`, `524A…`). The `5247…` service has no further characteristics. `1800`, `1801`, `180A` and `180F` were requested but not exposed: they are either absent or hidden by Chrome.
- Subscribing to `FFF1`, `5249…` and `524A…` succeeds.
- `FFF2` and `5248…` both accept writes with response (session 2). Accepted only means the BLE stack took the bytes, not that the hub understood them.

Observed with nRF Connect (before this project):

- Advertised name: `CB10-2023AAAA1514` (prefix `CB10`). Connects without bonding.
- `0x1800` Generic Access: Device Name (`2A00`) and Appearance (`2A01`) are writable. **Never write to these.**
- `0x1801` Generic Attribute: Service Changed (`2A05`, indicate).
- `0xFFF0`:
  - `FFF1`: notify, read
  - `FFF2`: write
- `00005247-0001-1000-8000-00805f9b34fb` (0x5247 = ASCII "RG"):
  - `00005248-0002-1000-8000-00805f9b34fb`: write
  - `00005249-0003-1000-8000-00805f9b34fb`: notify, read
  - `0000524a-0003-1000-8000-00805f9b34fb`: notify

To fill in: which characteristic carries motor commands, write with/without response, MTU / max payload length.

## Frames

Source: decompiled SmartBlocks Pro APK (package `com.cocomiao.smartpro`; encoder in `com.cocomiao.smartpro.ble.a`, channel map in `TApplication.d`, control screen in `RemoteControlActivity`). The plan originally ruled out the vendor app; the human later chose to decompile it. Everything below comes from the app code. **Motor frames are not yet verified on hardware**, except where noted.

Generic frame (both directions):

```
[header] [data …] [checksum] [0xDD]
checksum = (sum of data bytes) & 0xFF        header and 0xDD are not included
```

Verified against hardware: the hub's reply `88 80 FF FF FF FF 7C DD` has header `88`, data `80 FF FF FF FF`, checksum `0x80 + 4×0xFF = 0x47C → 7C`, then `DD`.

Motor command (app → `FFF2`), 16 bytes:

| Byte | Value | Meaning |
|---|---|---|
| 0 | `0x80`-`0x83` | Header = `0x80 + (channel − 1)`, channel 1-4 (same as the IR channel switch) |
| 1 | `0x80` | Constant prefix |
| 2, 3 | `F0`, speed | Port 1: app calls it "A", **hub socket labelled B** |
| 4, 5 | `F0`, speed | Port 2: app calls it "B", **hub socket labelled A** |
| 6-13 | `FF` × 8 | Ports 3-6, unused on CB10 (`FF` = port not used) |
| 14 | sum of bytes 1-13 & 0xFF | Checksum |
| 15 | `0xDD` | End marker |

Speed byte: `0x80` = stop. Control-screen dial `n` (0-99, steps of 5): one direction `0x80 + n`, the other `0x80 − n`; at 100 the app sends `0xFF` / `0x00`. Which direction is "forward" also depends on the per-motor "switching" toggle in the app. The app's ports A-F map to pairs 1-6 in order (only A and B are enabled by default); on this hub the physical labels of the first two are swapped (see Verified examples).

Stop all: the app sends the stop frame (`80 80 F0 80 F0 80 FF…`) once per channel `0x80`-`0x83`, 100 ms apart, when the Control screen opens.

Timing: the app queues commands, writes at most one every 50 ms, and re-sends the motor frame only when it changes. So no keep-alive is expected (verify: does a motor keep running after a single frame?).

Replies (`FFF1`): the app parses frames whose byte 1 is `0x80`/`0x81` (status, class `DeviceCMOS`). A reply `88 <ch> 00 00 00 00 …`, with byte 1 = `0x80`-`0x83`, reports the hub's channel switch position. That is how the app auto-detects the channel.

## Verified examples

| Action | Characteristic | Hex | Notes |
|---|---|---|---|
| Unknown, but recognised (no motion) | `FFF2` | `80 64 64 00` | Reply on `FFF1`: `00 00 00 00 00 00 00 00`. Reproduced 3× (sessions 4-5), alternating with `81 64 64 00`, which always gets the usual `88 80 FF FF FF FF 7C DD`. |
| Stop, channel 1 (hub on channel 1) | `FFF2` | `80 80 F0 80 F0 80 FF FF FF FF FF FF FF FF 58 DD` | Reply `88 80 00 00 00 00 80 DD`: the "channel found" frame the app waits for (byte 1 `80` = channel 1, then `00 00 00 00`, checksum `80`). Session 9. |
| Stop, channels 2-4 (hub on channel 1) | `FFF2` | `81…`, `82…`, `83…` + `80 F0 80 F0 80 FF FF FF FF FF FF FF FF 58 DD` | Usual `88 80 FF FF FF FF 7C DD` reply: frames for another channel are ignored. Session 9. |
| Motor A dial 30 (`0x9E`), channel 1 | `FFF2` | `80 80 F0 9E F0 80 FF FF FF FF FF FF FF FF 76 DD` | Accepted (reply `88 80 00 00 00 00 80 DD`). Hub LED starts **blinking**, motor does **not** turn. Same frame on channel 2 (`81…`) is ignored. Session 9. Byte-identical to what the app sends for A at 30 %. |
| **Motor runs** (full speed, channel 1) | `FFF2` | e.g. `80 80 F0 80 F0 FF FF FF FF FF FF FF FF FF D7 DD` | Session 10: motors move with the full-speed frames. **The hub's printed port labels are the reverse of the app's naming**: frame pair 1 (bytes 2-3, the app's "A") drives the socket labelled **B**, and pair 2 (bytes 4-5) drives the socket labelled **A**. Reported by the human as "labels the other way around". Exact frame→socket→direction mapping still to be confirmed. |
| Speed is proportional, with a dead band | `FFF2` | `0x80 ± n` | Session 11, control panel, wheels lifted: from standstill the motor starts only at **24 %** (`0x98`). Once turning it keeps running down to **20 %** (`0x94`) and stops at **19 %** (`0x93`). This is typical motor static friction; it likely varies with the motor, load and battery level. |
| Same command, any length | `FFF2` | `80`, `80 00`, `80 00 00`, `80 00 00 00`, `80 00 00 00 00 00 00 00` | Session 6: all get the same `00 00 00 00 00 00 00 00` reply, so 0x80 works as a 1-byte command and bytes after it don't change the reply. |

## Notifications

| Characteristic | Example hex | Meaning |
|---|---|---|
| all three | (none) | Idle with all three subscribed for about 2 min: no notifications. The hub does not send status or battery data on its own. |
| `FFF1` (notify) | `88 80 FF FF FF FF 7C DD` | Session 3: sent within 30-90 ms of **every** 4-byte write to `FFF2`. Identical for byte 0 = `0x00`-`0x10` with template `xx 64 64 00`, so it does not depend on that byte. Meaning unknown; maybe a generic "not understood" reply. |
| `FFF1` (notify) | `00 00 00 00 00 00 00 00` | Reply to `80 64 64 00`, reproducible (see Verified examples). No motion. |
| `FFF1` (read) | `00 00 00 00` | Idle value, 4 bytes. Still `00 00 00 00` right after the reply above, so reading does not return the last notification. |
| `5249…` (read) | `00 00 00 00` | Idle value, 4 bytes. |

## Rejected packets (no motion, no reply, read values unchanged)

Session 2, wheels lifted. All written with response. Each packet was tried on both `FFF2` and `5248…`:

`00`, `01`, `00 00`, `01 00`, `00 00 00`, `01 01 01`, `00 00 00 00`, `01 00 00 00`, `00 01 00 00`

`FFF1` and `5249…` read `00 00 00 00` before and after. Note: on `5248…` all three notify characteristics were subscribed. The `FFF2` round may have run without subscriptions (the log shows a fresh "Subscribe all" afterwards), so a reply on `FFF1` could have been missed there.

Session 3 (subscribed, `FFF2`): template `xx 64 64 00`, byte 0 = `0x00`-`0x10`. No motion reported; every packet got the reply `88 80 FF FF FF FF 7C DD` on `FFF1`.

Sessions 3-7 (subscribed, `FFF2`): byte 0 swept over the **full range `0x00`-`0xFF`** with template `xx 64 64 00`. Every value except `0x80` got the usual `88 80 FF FF FF FF 7C DD` reply. No motion at any value.

Session 8 (reported as "nothing happened", no log shared): `FFF2` byte 1 swept `0x00`-`0xFF` with template `80 xx 00 00`, and `5248…` byte 0 swept `0x00`-`0xFF` with template `xx 64 64 00`. The sweeper did not stop (no changed or first-ever reply) and there was no motion.

Why blind probing failed: motor frames are 16 bytes with a checksum and a `DD` end marker, so none of the short packets could ever be valid. The `0x80` "hit" was the channel-1 header byte; the hub probably answered a header it recognised with an invalid body.

## Unverified guesses

- Superseded by the app code (see Frames): the earlier ideas that `0x80` is a status query, that `88 80 FF…` means "unknown command", and that `7C DD` is a CRC. `7C` is the 8-bit sum of the data bytes and `DD` is the end marker.
- What the hub's reply `88 80 FF FF FF FF` means exactly (port status?) and why `80` on its own got `00 × 8` are not known; the app does not need either.
- `5247…` service: not referenced anywhere in the app, so it's probably unused by the official app.
- Program mode logic (timed runs, tones, songs) runs in the app (Scratch-based editor in `assets/scratch`), which sends the same motor frames.

## Open questions

- Which direction is speed `> 0x80` (the app's default "forward")?
- Does a motor keep running after a single frame (no keep-alive)?
- Must the header channel match the hub's channel switch?
