# Shure Third-Party Control Protocol: Reference Notes

These notes cover the families we target first: **ULX-D**, **Axient Digital (AD/ADX)**, and **SLX-D**.

**Sources:**
- Shure, *Command Strings for ULX-D Receivers* (technical bulletin, RW 1/12/2018). `content-files.shure.com/Pubs/ulx/ulx-d-network-string-commands.pdf`
- Shure, *Axient Digital Command Strings*, version 4 (2019-L). Current version: https://pubs.shure.com/command-strings/AD4/en-US
- Shure, *SLX-D Command Strings*, version 2 (2020-G). The copy we found is **incomplete** and needs re-checking against https://pubs.shure.com/command-strings/SLXD/en-US
- Micboard `py/` (MIT, Karl Swanson): field mappings for ULX-D and AD
- bitfocus `companion-module-shure-wireless` v2.3.1 (MIT, Joseph Adams): sample parsing for ULX/AD/SLX, framing, and keepalive

> ⚠️ All the documents above are several years old. Firmware since then may add fields. **Verify every row against a real receiver**, which we can do by logging the full `GET 0 ALL` response.

## Transport

| | ULX-D | Axient Digital | SLX-D |
|---|---|---|---|
| Transport | TCP client → receiver :2202 | same | same |
| Encoding | ASCII | ASCII | ASCII |
| Message | `< TYPE … >` | same | same |
| Channel `x` | 1–4 (0 = all) | 1–4 (0 = all) | 1–2 (0 = all) |
| Strings | `{…}`, 8 chars fixed | `{…}`, 31 chars, space-padded | `{…}`, 31 chars, space-padded |

- **Framing:** a TCP stream can split or merge messages, so buffer the incoming data and cut it at each `>`. Micboard does not buffer, and this is a known bug. Companion buffers correctly.
- **Message types:** `GET`/`SET` (client→rx), `REP` (rx→client, reply *and* unsolicited change report), `SAMPLE` (metering), `REP ERR`.
- Most parameters push a `REP` when they change, so we don't need to poll. Metered values (RF, audio, quality) arrive only in `SAMPLE`.
- **Startup:** send `< GET 0 ALL >`, then `< SET 0 METER_RATE 00100 >`. The rate is in ms: 0 = off, minimum 100, and metering is off by default.
- **Keepalive:** Companion sends `< GET 1 METER_RATE >` every 30 s and reconnects if no `METER_RATE` reply arrives within 60 s. With metering on, SAMPLEs arrive continuously, so silence of more than a few seconds means the link is dead.
- ⚠️ **QLX-D firmware ≥ 2.2.11 can lock up** after an unclean client disconnect (Micboard `docs/qlxd.md`). It is not known whether ULX-D, AD, or SLX-D are affected. On shutdown, always send `METER_RATE 0` and close the socket cleanly.

## Sentinel values ("not available")

From the ULX-D bulletin: **3-digit fields: 252–255. 5-digit fields: 65532–65535.** These mean the device is unavailable (TX off, not supported, and so on). AD and SLX-D use `255` and `65535` as "Unknown". String fields use `UNKN`, `UNKNOWN`, or an all-spaces `{}`.

The ULX-D charger adds `65534` = calculating and `65529` = full on `BATT_TIME_TO_FULL`.

**Rule:** a sentinel means *no reading*. It is never zero or low.

## Metering (`SAMPLE`)

| Family | Format | Conversion |
|---|---|---|
| ULX-D | `< SAMPLE x ALL nn aaa eee >` | `nn` antenna LEDs: `AX`, `XB`, `XX` (squelch-open diversity branch). `aaa` RF 000–115 → **dBm = aaa − 128**. `eee` audio 000–050 → dBFS ≈ eee − 50 (Companion's interpretation, unconfirmed). |
| AD (standard) | `< SAMPLE x ALL qual audBitmap audPeak audRms ant bmpA rssiA bmpB rssiB >` | `qual` 0–5 (255 = unknown). audPeak/audRms → **dBFS = v − 120**. ant: 2 chars, e.g. `BB`. rssi → **dBm = v − 120**. |
| AD (Quadversity) | as above, with `ant` 4 chars and 4×(bmp, rssi) | Antennas A–D |
| AD (FD-C) | as above, then a second `ant`+2×(bmp,rssi) block for F2 | Two frequencies |
| SLX-D | `< SAMPLE x ALL audPeak audRms rssi >` | all → **v − 120** (dBFS / dBm) |

Micboard maps RF to a percentage with `raw / 115` for both ULX-D and AD. Because ULX-D's offset is 128 and AD's is 120, the same percentage means different dBm values on each family. **RF Ranger stores dBm.**

## Channel fields we use

✅ = documented. ❌ = not available. ? = unknown, check against hardware.

| Concept | ULX-D | Axient Digital | SLX-D |
|---|---|---|---|
| Channel name | `CHAN_NAME` (8) | `CHAN_NAME` (31) | `CHAN_NAME` (31) |
| Frequency | `FREQUENCY` yyyyyy (kHz) | `FREQUENCY` 7 digits (kHz), `FREQUENCY2` for FD | `FREQUENCY` 7 digits (kHz) |
| Group/channel | `GROUP_CHAN gg,cc` | `GROUP_CHANNEL {g,c}`, `GROUP_CHANNEL2` | `GROUP_CHANNEL {g,c}` |
| Battery bars | `BATT_BARS` 0–5 | `TX_BATT_BARS` 0–5 | `TX_BATT_BARS` 0–5 |
| Battery % | `BATT_CHARGE` 0–100 (Shure rechargeable only) | `TX_BATT_CHARGE_PERCENT` | ? (missing from our copy) |
| Runtime (min) | `BATT_RUN_TIME` (Shure rechargeable only) | `TX_BATT_MINS` | `TX_BATT_MINS` |
| Battery type | `BATT_TYPE` ALKA/LION/LITH/NIMH/UNKN | `TX_BATT_TYPE` | ? |
| Battery health % | `BATT_HEALTH` | `TX_BATT_HEALTH_PERCENT` | ? |
| Battery cycles / temp | `BATT_CYCLE`, `BATT_TEMP_C` (+40 offset) | `TX_BATT_CYCLE_COUNT`, `TX_BATT_TEMP_C` | ? |
| TX model | `TX_TYPE` ULXD1/ULXD2/ULXD6/ULXD8/UNKN | `TX_MODEL` AD1/AD2/ADX1/ADX1M/ADX2/ADX2FD/UNKNOWN (newer firmware likely adds AD3/ADX3) | `TX_MODEL` SLXD1/SLXD2/… |
| **TX identity** | `TX_DEVICE_ID`, **ULXD6/ULXD8 only** | `TX_DEVICE_ID` (31, user-settable on ADX) | ❌ (not in our copy) |
| RX output mute | `AUDIO_MUTE` | `AUDIO_MUTE` | ? |
| TX mute | `TX_MUTE_STATUS`, ULXD6/8 only | `TX_MUTE_MODE_STATUS` ON/MUTE/UNKNOWN | ? |
| TX offset | `TX_OFFSET` (255 = TX off) | `TX_OFFSET` | ? |
| TX RF power | `TX_RF_PWR` | `TX_POWER_LEVEL` | ? |
| TX locks | `TX_PWR_LOCK`, `TX_MENU_LOCK` | `TX_LOCK` | ? |
| Interference | `RF_INT_DET` NONE/CRITICAL (fw ≥1.4.8) | `INTERFERENCE_STATUS(2)` NONE/DETECTED | ? |
| Encryption fault | `ENCRYPTION_WARNING` ON/OFF | `ENCRYPTION_STATUS` OK/ERROR | ? |
| Unregistered TX | ❌ | `UNREGISTERED_TX_STATUS` OK/ERROR | ❌ |
| Link quality | ❌ | `CHAN_QUALITY` 0–5 (metered) | ❌ |
| Diversity | 2 antennas (LED only) | 2 or 4 antennas, per-antenna RSSI | 1 RSSI |

**Device fields:** `MODEL`, `DEVICE_ID`, `FW_VER` (a trailing `*` means corrupt firmware), `RF_BAND`. AD adds `TRANSMISSION_MODE`, `QUADVERSITY_MODE`, and `ENCRYPTION_MODE`.

### Axient Digital transmitter slots (ShowLink/ADX)

AD channels have 8 registration slots (`SLOT_STATUS`, `SLOT_TX_MODEL`, `SLOT_TX_DEVICE_ID`, `SLOT_BATT_*`, `SLOT_SHOWLINK_STATUS`). These report the batteries and identities of *registered spare transmitters*, including ones not currently on air. Later on, this lets us monitor spares directly.

## What this means for RF Ranger

1. **Is a transmitter present?** No protocol has a single "TX on" flag. We infer presence from fields that switch between real values and sentinels: `TX_OFFSET` ≠ 255, battery bars ≠ 255, and `TX_TYPE`/`TX_MODEL` ≠ UNKN. Squelch-open antenna LEDs and RSSI also help. This rule must be validated on hardware for each family.
2. **Transmitter identity (swap detection):**
   - Axient Digital: `TX_DEVICE_ID` works.
   - ULX-D: only ULXD6/ULXD8 report an ID. ULXD1/ULXD2 report only the model.
   - SLX-D: probably model only.

   The adapter must declare which applies. Where only the model is available, the UI should say "model matches" rather than "verified transmitter".
3. **Battery %** exists only with Shure rechargeables. With AA batteries we have bars only, and runtime is unavailable. This is not a fault.
4. **RF in dBm, audio in dBFS, with per-family offsets.** The adapter normalises to these units. Raw values are kept for diagnostics.

## Networked chargers (SBC220 / SBC240)

Source: Shure *SBC220 SBC240 Command Strings*, v2.0 (2020-K). Same transport (TCP :2202, `< … >`). Up to 4 chargers can be ganged on one connection, and bays are numbered across the gang. The charger is the server.

| Key | Values | Notes |
|---|---|---|
| `BATT_DETECTED` | YES / NO | |
| `BATT_CHARGE` | 000–100 % | |
| `BATT_BARS` | 000–005 | |
| `BATT_HEALTH` | 000–100 %, 254 error, 255 unknown | |
| `BATT_TIME_TO_FULL` | 0–65528 min, **65529 full**, 65533 calculating, 65534 error, 65535 none | The sentinels are not minutes |
| `BATT_STATE` | NORMAL / FULL / CALCULATING | |
| `BATT_ERROR` | 000 none, 001–007 faults, 255 no battery | |
| `STORAGE_MODE` | ON / OFF | Charges to storage level, not full |

Values are reported **on change only**. There is no metering, so RF Ranger polls `GET DEVICE_ID` to prove the link is alive. **The charger does not identify which transmitter is docked.** It has no model, serial, or frequency per bay.

The older SBC450/SBC850 (SB900 batteries) use a different string set, documented in the ULX-D bulletin. It only identifies ULXD6/ULXD8 transmitters and is not implemented yet.

## In-ear monitors: PSM 1000 (P10T) — provisional

Sources: Shure *PSM1000 Command Strings* (https://pubs.shure.com/command-strings/PSM1000/en-US) and bitfocus `companion-module-shure-psm1000` (MIT, © 2020 Bitfocus AS). **None of this has been checked against a real P10T yet.**

IEM is the reverse of a mic system. The networked rack unit is the **transmitter** (P10T, 2 channels). The **P10R/P10R+ bodypack only receives**, so pack battery, pack RF, and whether the pack is even switched on are invisible on the network. RF Ranger therefore reports on what the rack is sending, and judges the pack only through an assigned charger bay.

| Concept | Key | Values (per Companion; parsers also accept the word forms) |
|---|---|---|
| Device name | `DEVICE_NAME` | used instead of `DEVICE_ID` |
| Channel name | `CHAN_NAME` | |
| Frequency | `FREQUENCY` | 6 digits, kHz (`518125` = 518.125 MHz) |
| Group/channel | `GROUP_CHAN` | `gg,cc` |
| RF output | `RF_TX_LVL` | 10 / 50 / 100 (mW) |
| RF mute | `RF_MUTE` | 1 muted, 0 on air |
| Audio mode | `AUDIO_TX_MODE` | 1 mono, 2 point to point, 3 stereo |
| Line level | `AUDIO_IN_LINE_LVL` | 0 aux (−10), 1 line (+4) (not used yet) |
| Input gain | `AUDIO_IN_LVL` | dB (not used yet) |
| Metering | `METER_RATE` / `SAMPLE` | `SAMPLE` layout unknown; ignored until captured |

Differences from the receivers, handled by `ShureFamily.deviceIdKey` and `getAll: false`:
- RF Ranger doesn't rely on `GET 0 ALL`. It reads each key per channel on connect, as Companion does.
- `MODEL` may not be answered, so identification falls back to `GET 1 AUDIO_TX_MODE`, which only a P10T answers.

**To verify on hardware:** whether `MODEL` and `GET 0 ALL` work, the exact `RF_TX_LVL` / `RF_MUTE` / `AUDIO_TX_MODE` encodings, and the `SAMPLE` layout (which could add input-level metering). Run `npm run probe -- psm1000 <ip>` and attach the log to a device report.

Not supported yet: **PSM 900 / PSM 300** (no network control), **Axient Digital PSM** (ADTD/ADTQ; identified and declined with a message).

## Freshness of reported values

`REP` values (battery, TX model, faults) arrive **only on change**. A battery that sits at 92 % sends nothing new. RF Ranger therefore re-reads each family's key reported values every 30 s (`ShureFamily.poll`). This keeps steady values fresh and corrects any missed report. Readings older than 2 minutes are treated as unknown, so a link that silently stops answering polls can never leave a stale "good" value on screen.
