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
| 6 | TX not present (switched off or out of range) | CHECK WITH AUDIO | "Transmitter off" |
| 7 | Battery reading is anything except a fresh `ok` | CHECK WITH AUDIO | "Battery unknown" |
| 8 | Battery is in the warning band (2–3 bars, or ≤ 50 %) | CHECK WITH AUDIO | "Battery low" |
| 9 | Everything above passed | READY | n/a |

The Pickup View shows only the label. The Engineer View shows the label **and** the reason.

**Open question for production use:** before a service, transmitters are often switched off on the table, which by rule 6 shows CHECK WITH AUDIO. If the team charges and powers on everything ahead of time, this is correct. Otherwise we may want an "off but last seen charged" state. That must be *clearly* labelled, so we don't repeat Micboard's `PREV_GOOD` problem. With Axient Digital, ShowLink slot data may report battery levels for transmitters that are not on air.

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
