# RF Ranger Architecture (draft)

## Decisions so far

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript throughout (Node ≥ 20 server, browser UI) | One language, and shared types between server and UI. Node's `net`/`dgram` handle TCP and multicast on macOS and Windows. |
| First platforms | macOS and Windows | Typical production laptops and PCs. Linux and Raspberry Pi should work but are not a target yet. |
| First hardware | Shure ULX-D, then Axient Digital, then SLX-D | ULX-D and AD are available for testing. SLX-D is wanted. |
| Codebase | New codebase, with Micboard protocol knowledge ported under MIT | See [micboard-audit.md](micboard-audit.md) §9 |

## Layers

```
 receivers ─▶ adapters (shure, later sennheiser) ─▶ state store ─▶ derive (alerts, readiness) ─▶ API (HTTP + WebSocket) ─▶ Engineer View / Pickup View
                      ▲                                   ▲
              per-family capability                config: receivers, transmitters,
              declaration                          artists, assignments, groups, thresholds
```

- **Adapter:** owns sockets, framing, parsing, and unit conversion for one manufacturer. It emits normalised `ChannelTelemetry` updates. It knows nothing about artists.
- **State store:** a single source of truth. Receivers, channels, and telemetry, each with a timestamp.
- **Derive:** pure functions such as `(telemetry, assignment, thresholds, now) → alerts + readiness`. They are unit-tested and have no I/O.
- **API:** a full snapshot over HTTP, deltas over WebSocket, and config CRUD. It will also offer a Micboard-compatible `/data.json`.

## Readings: never confuse "missing" with "low"

Every metric is a `Reading<T>`:

| `state` | Meaning | UI shows |
|---|---|---|
| `ok` | Value received, with timestamp `at` | The value. Shown as stale if `now − at` exceeds that metric's maximum age. |
| `absent` | The device answered with a sentinel (TX off, AA battery, …) | "—" with a reason |
| `unsupported` | This family or model can't report it | Hidden, or "n/a" |
| `unknown` | Nothing received yet since connecting | "…" |

Staleness is calculated when the data is read, not stored. That way a frozen socket can never leave an old "good" value on screen.

## Core entities

Assignments are kept separate from the hardware, as the spec requires.

- **Receiver:** manufacturer, family, model, host, deviceId, firmware, band, `connection { state, since, lastMessageAt, lastError }`
- **ReceiverChannel:** `receiverId + channel number`, plus live `ChannelTelemetry`
- **Transmitter:** inventory ID, manufacturer, model, and optional hardware identity (`TX_DEVICE_ID` where the family supports it)
- **Artist:** name, photo, role or instrument, group
- **Assignment:** artist → receiver channel, expected transmitter(s), pickup notes, display group
- **Slot / layout:** an ordered list of tiles per group, including blank spacers. This matches Micboard's slots and groups so existing configs can be imported.

## Capabilities

Each adapter declares a capability set **per family** and **per TX model**. For example, ULX-D with a ULXD2 reports no `txDeviceId` and no `txMute`, while a ULXD6 reports both. The UI uses this to tell `unsupported` apart from `absent`.

## Readiness (Pickup View): draft rules

All thresholds are configurable. Rules are evaluated in order, and **the first match wins**. There are four labels, each with its own colour: READY (green), STANDBY (orange: switched off, on the charger, or not yet known to be fine), NOT READY (red: low battery or a fault), and UNASSIGNED (grey). Each result also has a short status, which is what the pill shows ("Ready", "Off", "On charger", "Battery low", …).

The battery is judged by its percentage whenever the transmitter reports one, because Shure's bars don't line up with it. Bars are used only when there is no percentage, for example with AA cells.

| # | Condition | Label · status | Reason shown to engineer |
|---|---|---|---|
| 1 | No assignment, and no transmitter on | UNASSIGNED · Spare | n/a |
| 2 | Receiver not connected, or no message for > 5 s | NOT READY · Offline | "Receiver offline" |
| 3 | Assigned TX identity is supported **and** mismatches | NOT READY · Wrong transmitter | "Wrong transmitter: expected X, seeing Y" |
| 4 | Fault: encryption error, unregistered TX, or critical interference | NOT READY · the fault | the fault name |
| 5 | Battery is critical (≤ 20 %, or ≤ 1 bar without a %) | NOT READY · Battery critical | "Battery critical" |
| 6 | TX not present (switched off or out of range), with no charger bay assigned | STANDBY · Off | "Transmitter off or out of range" |
| 6a | TX not present, and the assigned charger bay holds a battery with no fault | STANDBY · On charger / Charging | "On charger, 95%" / "Charging, 60%, full in 20 min" |
| 6b | TX not present, and the bay is empty, offline, or in storage mode | STANDBY · Off / Storage mode | "not on its charger" / … |
| 6c | TX not present, and the bay reports a charger fault | NOT READY · Charger fault | "Charger: Check battery" |
| 7 | Battery reading is anything except a fresh `ok` | STANDBY · Battery unknown | "Battery level unknown" |
| 8 | Battery is in the warning band (≤ 50 %, or 2–3 bars without a %) | NOT READY · Battery low | "Battery low" |
| 9 | Everything above passed | READY · Ready | n/a |

A channel without an assignment still goes through rules 2–9 once its transmitter is on. That way a channel named only "RF-4" still shows its battery and faults. On an engineer screen, a channel that the active show preset gives a nickname counts as assigned there, so when it's off it shows "Off" rather than "Spare".

**In-ear monitors (role `iem`).** On an IEM channel the networked unit is the transmitter, and the bodypack only receives. The pack reports nothing, so rules 3–8 don't apply. They are replaced by:

| # | Condition | Label | Reason shown to engineer |
|---|---|---|---|
| 1–2 | As above | | "IEM transmitter offline" |
| I1 | RF muted, or RF output 0 | NOT READY | "IEM RF muted" / "IEM RF off" |
| I2 | RF mute or RF level is not a fresh `ok` | STANDBY · State unknown | "IEM transmitter state unknown" |
| I3 | A charger bay is assigned | rules 6a–6c, for the pack | "On charger, 100%" / "IEM pack not on its charger" / … |
| I4 | No charger bay, `iemReadyWithoutCharger` false (default) | STANDBY · On air | "IEM on air; pack battery not monitored" |
| I4′ | No charger bay, `iemReadyWithoutCharger` true | READY · On air | "IEM on air; pack not monitored" |

I4 is conservative on purpose. Nothing proves the pack is charged. Shows that don't track IEM packs on chargers can opt into I4′ in `thresholds`.

The Pickup View shows only the label. The Engineer View shows the label **and** the reason.

**Chargers.** Between uses, transmitters sit docked in networked chargers (SBC220 for AD1/AD2/ULXD1/ULXD2, SBC240 for ADX). While docked, the receiver sees them as off. Each assignment can name a **charger bay**, and while the transmitter is off its readiness comes from that bay (rules 6a–6c). The charger reports what's in a bay, but not *which* transmitter it is. So "READY (on charger)" means "a charged battery is in this artist's bay". Once the artist powers it on, the live receiver rules take over, and on Axient the transmitter-ID check confirms it's the right one. Bay values are trusted only while the charger connection is live, which is kept verified by polling.

## Engineer alerts (independent of readiness)

The engineer alerts are receiver offline, data stale, TX lost while assigned, battery warning/critical, runtime below threshold, RF below threshold for N seconds, interference, encryption fault, unregistered TX, TX identity mismatch, firmware corrupt (`*` in `FW_VER`), and receiver output muted (`AUDIO_MUTE ON`).

## Repo layout (planned)

```
server/            Node service: adapters, store, derive, API
  src/core/        model types, readings, readiness (pure; shared with web)
  src/adapters/device.ts      what the runtime needs from any receiver (ReceiverDevice)
  src/adapters/families.ts    every family across makers; createReceiverDevice()
  src/adapters/shure/         Shure TCP command strings (ULX-D, AD, SLX-D, PSM 1000, chargers)
  src/adapters/sennheiser/    Sennheiser SSC v1, JSON over UDP port 45 (EW-DX, Digital 6000)
web/               UI (Engineer + Pickup views)
docs/
```
