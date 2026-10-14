# Micboard Audit

**Audited:** 2026-10-13
**Upstream:** https://github.com/karlcswanson/micboard (`master` @ `166987d`, v0.8.5, 2019-10-10)
**Method:** Source review only. The application has not yet been run, and no readings have been compared against real hardware. Every claim about device behaviour below comes from Micboard's code and docs and must be confirmed on a receiver.

---

## 1. License and attribution

| Item | Finding |
|---|---|
| License | **MIT**, `Copyright (c) 2019 Karl Swanson` |
| Reuse allowed? | Yes. Copying, modifying, redistributing, and sublicensing are all permitted. |
| Obligation | The copyright notice and MIT permission text must be included in every copy or substantial portion. |
| Name / logo | The license does not cover the "Micboard" name, the logo, or `micboard.io`. RF Ranger must not use them as its own branding. Describing the project as "based on Micboard" is factual and fine. |
| `dcid.json` | This file is derived from Shure's `DCIDMap.xml`, which ships with Shure Update Utility. Its redistribution terms are Shure's, not Karl's. **Open question:** we either confirm we can ship it, or generate it locally at install time from the user's own Shure software. |
| Shure protocol docs | Shure publishes them openly for third-party control (Crestron/AMX). Implementing them independently is fine. |
| Frontend dependencies | All permissive (MIT, BSD, Apache). Nothing copyleft was found in `package.json`. |

**Action:** Add a `NOTICE` file that carries Micboard's MIT notice. Keep per-file attribution headers on any ported module.

## 2. Project status

- Last upstream release: **v0.8.5, 2019-10-10**. An unreleased upstream branch, `0.8.7`, has 12 more commits, including a UHF-R battery-time fix (#16), Axient "powerlock" support, and the ability to keep extended names when the config changes.
- 117 stars, 49 forks, 20 open issues, not archived.
- **Active community forks (as of 2026-10):**
  - `joshualvin/micboard` (v0.9.6, 92 commits ahead). It merges `wjarrell-ccc/micboard` and upstream `0.8.7`, moves to webpack 5 and Bootstrap 5, replaces node-sass, and adds a background photo manager with HEIC support.
  - `wjarrell-ccc/micboard` (v0.9.5, 37 commits ahead). It focuses on Docker and Raspberry Pi deployment and the photo manager.
  - `s0600204/micboard` (51 commits ahead). It adds multi-arch Docker builds.
  - None of these forks restructure the receiver/data layer. Their Python changes are small.

## 3. Architecture

```
 Shure receivers ──TCP/UDP :2202──▶ shure.SocketService (thread, select loop)
                                        │ raw lines
                                        ▼
                                  DeviceMessageQueue ──▶ ProcessRXMessageQueue (thread)
                                                              │ mutates channel objects
                                                              ▼
 SLP multicast ──▶ discover.discover (thread)      data_update_list / chart_update_list (globals)
 239.255.254.253:8427                                          │
                                                              ▼
 shure.WirelessQueryQueue (thread, every 10 s)     tornado ws_dump every 50 ms ──▶ /ws (WebSocket)
                                                   /data.json (full snapshot)
```

- **Backend:** Python 3 and Tornado, about 1,500 lines across 12 files in `py/`. One external dependency (`tornado`).
- **Threads:** five (socket I/O, message parsing, periodic query, discovery, web).
- **Frontend:** vanilla ES modules with jQuery, Bootstrap 4, Smoothie charts, and Shopify Draggable, built with webpack 4 and node-sass. It is one page (`demo.html`) with modes chosen by keyboard and URL hash.
- **Packaging:** PyInstaller binary, an Electron 5 wrapper (macOS), a Dockerfile (Node 10), and a systemd unit.
- **Config:** one `config.json` in the OS app-data directory, containing slots, groups, and extended names. Backgrounds go in a `backgrounds/` folder and are matched to channel names by filename.

### HTTP / WebSocket API

| Route | Method | Purpose |
|---|---|---|
| `/data.json` | GET | Full snapshot: receivers, per-channel data, **raw device key/values**, config, discovered devices, background file lists |
| `/ws` | WS | Pushes `data-update`, `chart-update`, and `group-update` deltas every 50 ms |
| `/api/slot` | POST | Save extended ID and name for slots |
| `/api/group` | POST | Save group title and slot list |
| `/api/config` | POST | Replace all slots and restart the device layer |
| `/bg/*`, `/static/*` | GET | Background media and static assets |

No endpoint requires authentication, and `check_origin` returns `True`.

## 4. Supported hardware

| Micboard type | Family | Models (from `DCID_MODEL`) | Transport | Line delimiter |
|---|---|---|---|---|
| `uhfr` | UHF-R | UR4S, UR4D | **UDP** 2202 | `* … *` |
| `qlxd` | QLX-D | QLX-D single (incl. 1G, ISM) | TCP 2202 | `< … >` |
| `ulxd` | ULX-D | ULXD4 single/dual/quad (incl. 1G, ISM) | TCP 2202 | `< … >` |
| `axtd` | Axient Digital | AD4D, AD4Q | TCP 2202 | `< … >` |
| `p10t` | PSM 1000 (IEM) | P10T | TCP 2202 | `< … >` |
| `offline` | none | Placeholder slots (e.g. PSM 900) | none | none |

**Not supported:** SLX-D, ADX-only receivers (if any differ from AD4D/AD4Q), SLX, BLX, PSM 900, and any Sennheiser product.

### Discovery

- Micboard listens for SLP multicast on `239.255.254.253:8427`, extracts the `cd:` (DCID) token, and looks it up in `dcid.json` to get the model, band, and channel count.
- Discovered devices are only listed, not connected automatically. A user drags them into slots.
- **Platform bug:** `discover.py` uses `socket.SO_REUSEPORT` (which is missing on Windows) and binds directly to the multicast address (which fails on Windows). **Discovery does not work on Windows**, and its thread dies quietly.
- Discovery only works on the primary NIC.

### Connection lifecycle

1. Open a socket, set `METER_RATE` to 100 ms, and queue `GET {ch} ALL`.
2. Re-query the name and battery every 10 s.
3. Watchdog: CONNECTED with no data for 5 s → disconnect. CONNECTING for 2 s → disconnect. DISCONNECTED for 20 s → reconnect.

## 5. Telemetry: what is collected and how it is normalised

| Metric | UHF-R | QLX-D / ULX-D | Axient Digital | Notes / problems |
|---|---|---|---|---|
| Battery | `TX_BAT` (bars) | `BATT_BARS` 0–5 | `TX_BATT_BARS` | **Bars only.** AD reports `TX_BATT_CHARGE_PERCENT` and `TX_BATT_HEALTH_PERCENT`, but Micboard ignores them. `255` / `U` = unknown. |
| Runtime | not supported | `BATT_RUN_TIME` (min) | `TX_BATT_MINS` | 65533–65535 are treated as "no value". Runtime only exists with Shure rechargeables. |
| RF level | sample field | sample field | sample `RSSI` | Rescaled to a "0–100" number (`raw/115`, or `(100-raw)/80` for UHF-R). **This is not calibrated dBm**, so it means different things on different families. |
| Diversity / antenna | sample field | `RF_ANTENNA` (e.g. `AX`, `XB`) | sample | Kept as a raw 2-char string. AD has two RSSI values (A/B), but Micboard keeps only one. |
| Audio level | bitmap → MSB scale | `AUDIO_LVL` ×2 | `AUDIO_LEVEL_RMS` −20 | Per-family magic constants. A "peak" flag is set at ≥80 or by bitmap bit 7. |
| Frequency | `FREQUENCY` | `FREQUENCY` | `FREQUENCY` | Formatted as `MHz.kHz` text |
| Channel name | `CHAN_NAME` | `CHAN_NAME` | `CHAN_NAME` | Parsed into "ID + name" using a regex heuristic |
| TX offset / gain | none | `TX_OFFSET` | `TX_OFFSET` −12 | |
| Link quality | none | none | `CHAN_QUALITY` | AD only |
| Mute | none | none | raw only (`AUDIO_MUTE`, `TX_MUTE_MODE_STATUS`) | **Not surfaced** |
| TX model / ID | none | none | raw only (`TX_MODEL`, `TX_DEVICE_ID`) | **Not surfaced.** We need these for transmitter-identity and swap detection. |
| Interference, encryption | none | none | raw only | **Not surfaced** |
| Receiver model / FW / band | none | none | raw (`MODEL`, `FW_VER`, `RF_BAND`) | Kept only in `raw` |

Any field a receiver reports ends up in the per-channel `raw` map in `/data.json`. This is useful because we can see everything the device sends without changing the parser.

## 6. Status logic

Micboard collapses each mic channel into a single `status` string (`mic.py::tx_state`), evaluated top to bottom:

1. `RX_COM_ERROR`: receiver socket is not connected
2. `AUDIO_PEAK`: peak seen in the last 10 s
3. `GOOD` / `REPLACE` / `CRITICAL`: battery bars 4–5 / 3 / 0–2
4. `PREV_GOOD` / `PREV_REPLACE` / `PREV_CRITICAL`: battery is now unknown, but a valid reading was seen in the last 30 min
5. `TX_COM_ERROR`: anything else

IEM channels are always `UNASSIGNED` while connected.

**Conflicts with the RF Ranger spec:**
- **A stale reading counts as healthy.** If a transmitter is switched off, the channel shows `PREV_GOOD` for up to 30 minutes. This breaks guiding principle #9.
- **Audio peak hides battery state.** A singing artist with a critical battery shows `AUDIO_PEAK`, not `CRITICAL`.
- **One flag does too much.** Connection, transmitter presence, battery, and audio activity all share one string. The spec requires readiness to come from explicit, documented rules.
- There is **no separation between "unsupported" and "missing"**. Unsupported metrics are just absent or set to sentinel values (`255`, `65535`, `'XX'`).
- **Assignment and hardware are mixed together.** "Extended names" are the only assignment concept, and they are keyed to the channel. They are cleared automatically when someone renames the channel in WWB. There is no transmitter-identity check.

## 7. Defects and reliability risks

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | High | **TCP framing:** each `recv(1024)` result is split on `>` with no buffering between reads, so a message that straddles two reads is parsed as two broken lines. | `shure.py` `SocketService` |
| 2 | High | **Thread safety:** global lists such as `data_update_list` are appended to in the parser thread and cleared in the Tornado thread without locks. Updates can be lost. | `channel.py`, `tornado_server.py` |
| 3 | High | **No authentication or CSRF protection.** Any page on the network can `POST /api/config` and rewrite the receiver list. | `tornado_server.py` |
| 4 | High | **Stale data looks healthy** (`PREV_*` states, see §6). | `mic.py` |
| 5 | Med | One socket's `recv` failing hits `break`, so the remaining sockets are skipped for that loop iteration. | `shure.py` |
| 6 | Med | `reconfig` calls `time.sleep(2)` inside a Tornado request handler, which blocks the event loop. It also closes every WebSocket. | `config.py` |
| 7 | Med | `get_chan_name()` (a getter called on every JSON dump) can change the config and write it to disk. | `channel.py` |
| 8 | Med | Discovery is broken on Windows (see §4). | `discover.py` |
| 9 | Med | RF level is shown as an uncalibrated percentage that differs by family. | `mic.py` |
| 10 | Med | **QLX-D firmware ≥ 2.2.11 locks up** when a control client disconnects uncleanly (reported to Shure in 2018). We must check whether current QLX-D firmware fixes this before we rely on QLX-D. | `docs/qlxd.md` |
| 11 | Low | No receiver timestamp or "last updated" value is exposed to clients. Freshness is invisible. | everywhere |
| 12 | Low | Bare `except:` blocks swallow errors throughout, which hides parse problems. | everywhere |
| 13 | Low | There are no tests. | none |
| 14 | Build | node-sass 4, webpack 4, Electron 5, and Docker Node 10 do not build on current toolchains. The forks have fixed this. | `package.json` |

## 8. Features worth preserving

These are the workflows existing Micboard users depend on:

- **Slots:** a stable number for each receiver channel, independent of IP and channel.
- **Groups 1–9:** named, ordered layouts selected with number keys. In practice, one group is one storage-shelf display.
- **TV / storage view:** large tiles, with background images matched to a name (the artist photo), and **BLANK** spacer tiles to match the physical shelf layout.
- **Extended names and bulk paste loader:** the forerunner of RF Ranger's artist assignments.
- **Discovery → drag into slot** configuration editor.
- **Demo mode** (`d`). RF Ranger's demo needs a clear visual watermark.
- **QR code** to open the same view on a phone.
- **Keyboard-driven operation** (`0–9`, `t`, `f`, `g`, `e`, `n`, `s`, `?`).
- **`/data.json` with raw device fields:** people build InfluxDB loggers and LED meters on it. Keep a compatible endpoint.
- **Multivenue** (an nginx front for several instances).
- **Shared backgrounds folder over SMB:** teams update photos without touching the app.

## 9. Retain / adapt / replace

| Component | Decision | Reason |
|---|---|---|
| Shure command strings, sample field layouts, sentinel values, DCID→model table | **Retain (port with attribution)** | This is the valuable, hard-won protocol knowledge. It is small and well contained. |
| Connection watchdog timings (5 s / 2 s / 20 s) | **Adapt** | Reasonable starting values. Make them configurable and expose them as state. |
| Status logic (`tx_state`) | **Replace** | Conflicts with the spec (§6). Replace it with explicit readiness rules over typed, timestamped metrics. |
| Threading and global lists | **Replace** | Unsafe (§7 #1, #2). Use an async single event loop with per-connection framing buffers. |
| Config format | **Adapt** | Import Micboard `config.json` (slots, groups, extended names) so existing users can migrate. |
| `/data.json` + `/ws` | **Adapt** | Provide a Micboard-compatible endpoint alongside a new, documented RF Ranger API. |
| Frontend | **Replace** | jQuery and a single page with keyboard modes cannot cleanly hold two dedicated interfaces (pickup and engineer). Keep the workflows and shortcuts. |
| Electron wrapper, PyInstaller | **Drop for now** | Use a browser plus a service install. Revisit desktop packaging later. |

### Recommendation: structured port, not a git fork

The fork-and-modernize route that the spec prefers has, in effect, already been done by the community forks. What they did not change is the core RF Ranger needs to be different: the data model, the status semantics, the threading, and the API. Those are about 80% of the backend. The remaining 20%, the protocol knowledge, ports directly.

So the proposal is:
1. Start RF Ranger as its own codebase (this repo).
2. Port the Shure protocol layer from Micboard, with MIT attribution in `NOTICE` and in the ported file headers.
3. Use upstream `0.8.7` and the `joshualvin` fork as references for protocol fixes made after 0.8.5.
4. Provide a Micboard config importer and a compatible `/data.json` so migration costs little.

## 10. Open questions

1. **Which Shure receivers are available for testing?** (Exact models, bands, and firmware.) This decides the first adapter.
2. **QLX-D firmware lock-up:** is it still present on current firmware?
3. **SLX-D:** is it needed? It is common in churches and venues, and Micboard does not support it.
4. **Does ULX-D report battery percentage** (with SB900 rechargeables) in addition to bars? It needs checking against Shure's ULX-D command-string doc.
5. **`dcid.json` redistribution:** ship it, or generate it locally?
6. **Deployment target:** Raspberry Pi, a Linux mini-PC, a Mac, or a Windows production PC? This affects the discovery implementation and service install.
7. **Sennheiser families:** EW-DX, EW-D, Digital 6000, or G4 (each uses a different protocol)?
