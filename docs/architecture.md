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

All thresholds are configurable. Rules are evaluated in order, and **the first match wins**:

| # | Condition | Label | Reason shown to engineer |
|---|---|---|---|
| 1 | No assignment, or no channel assigned | SPARE / UNASSIGNED | n/a |
| 2 | Receiver not connected, or no message for > 5 s | NOT READY | "Receiver offline" |
| 3 | Assigned TX identity is supported **and** mismatches | NOT READY | "Wrong transmitter: expected X, seeing Y" |
| 4 | Fault: encryption error, unregistered TX, or critical interference | NOT READY | the fault name |
| 5 | Battery is critical (≤ 1 bar, or ≤ 20 %) | NOT READY | "Battery critical" |
| 6 | TX not present (switched off or out of range), with no charger bay assigned | CHECK WITH AUDIO | "Transmitter off" |
| 6a | TX not present, and the assigned charger bay holds a battery at ≥ 90 % with no fault | READY (on charger) | "On charger, 95%" |
| 6b | TX not present, and the bay is charging below 90 %, empty, offline, or in storage mode | CHECK WITH AUDIO | "Charging, 60%, full in 20 min" / "not on its charger" / … |
| 6c | TX not present, and the bay reports a charger fault | NOT READY | "Charger: Check battery" |
| 7 | Battery reading is anything except a fresh `ok` | CHECK WITH AUDIO | "Battery unknown" |
| 8 | Battery is in the warning band (2–3 bars, or ≤ 50 %) | CHECK WITH AUDIO | "Battery low" |
| 9 | Everything above passed | READY | n/a |

**In-ear monitors (role `iem`).** On an IEM channel the networked unit is the transmitter, and the bodypack only receives. The pack reports nothing, so rules 3–8 don't apply. They are replaced by:

| # | Condition | Label | Reason shown to engineer |
|---|---|---|---|
| 1–2 | As above | | "IEM transmitter offline" |
| I1 | RF muted, or RF output 0 | NOT READY | "IEM RF muted" / "IEM RF off" |
| I2 | RF mute or RF level is not a fresh `ok` | CHECK WITH AUDIO | "IEM transmitter state unknown" |
| I3 | A charger bay is assigned | rules 6a–6c, for the pack | "On charger, 100%" / "IEM pack not on its charger" / … |
| I4 | No charger bay, `iemReadyWithoutCharger` false (default) | CHECK WITH AUDIO | "IEM on air; pack battery not monitored" |
| I4′ | No charger bay, `iemReadyWithoutCharger` true | READY | "IEM on air; pack not monitored" |

I4 is conservative on purpose. Nothing proves the pack is charged. Shows that don't track IEM packs on chargers can opt into I4′ in `thresholds`.

The Pickup View shows only the label. The Engineer View shows the label **and** the reason.

**Chargers.** Between uses, transmitters sit docked in networked chargers (SBC220 for AD1/AD2/ULXD1/ULXD2, SBC240 for ADX). While docked, the receiver sees them as off. Each assignment can name a **charger bay**, and while the transmitter is off its readiness comes from that bay (rules 6a–6c). The charger reports what's in a bay, but not *which* transmitter it is. So "READY (on charger)" means "a charged battery is in this artist's bay". Once the artist powers it on, the live receiver rules take over, and on Axient the transmitter-ID check confirms it's the right one. Bay values are trusted only while the charger connection is live, which is kept verified by polling.

## Engineer alerts (independent of readiness)

The engineer alerts are receiver offline, data stale, TX lost while assigned, battery warning/critical, runtime below threshold, RF below threshold for N seconds, interference, encryption fault, unregistered TX, TX identity mismatch, firmware corrupt (`*` in `FW_VER`), and receiver output muted (`AUDIO_MUTE ON`).

## Repo layout (planned)

```
server/            Node service: adapters, store, derive, API
  src/core/        model types, readings, readiness (pure; shared with web)
  src/adapters/shure/
web/               UI (Engineer + Pickup views)
docs/
```
