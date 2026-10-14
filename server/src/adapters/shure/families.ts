/**
 * Per-family mapping from Shure command strings to RF Ranger telemetry.
 *
 * Field names, sample layouts, offsets and sentinels come from Shure's
 * published command-string documents, cross-checked against Micboard
 * (MIT, (c) 2019 Karl Swanson) and bitfocus companion-module-shure-wireless
 * (MIT, (c) 2019 Joseph Adams). See NOTICE and docs/shure-protocol.md.
 */
import { emptyTelemetry, type ChannelRole, type ChannelTelemetry, type Metric } from '../../core/model.js';
import { absent, ok, UNSUPPORTED, type Reading } from '../../core/reading.js';

export type ShureFamilyId = 'ulxd' | 'axd' | 'slxd' | 'psm1000';

type Apply = (t: ChannelTelemetry, args: string[], now: number) => void;

export interface ShureFamily {
  id: ShureFamilyId;
  label: string;
  /** `iem` families are in-ear monitor transmitters; see ChannelRole. */
  role: ChannelRole;
  defaultChannels: number;
  /** Device-level name key: Wireless Workbench's device name. */
  deviceIdKey: 'DEVICE_ID' | 'DEVICE_NAME';
  /** TCP control port: 2202 for receivers and chargers, 2201 for the PSM 1000. */
  defaultPort: number;
  /**
   * Whether `GET 0 ALL` returns every channel value. Without it, each report
   * key is read individually per channel on connect.
   */
  getAll: boolean;
  /** Metrics this family can report. Everything else starts as `unsupported`. */
  supports: ReadonlySet<Metric>;
  reports: Readonly<Record<string, Apply>>;
  applySample: Apply;
  /**
   * Reported-on-change values that are re-read periodically, so a value that
   * simply hasn't changed stays fresh and a missed report self-corrects.
   */
  poll: readonly string[];
}

// ---- value parsers -------------------------------------------------------

/**
 * Shure numeric fields: 252-255 (3-digit) and 65532-65535 (5-digit) are
 * "device unavailable" codes, never real values.
 */
export function numeric(raw: string | undefined, now: number, transform: (n: number) => number = (n) => n): Reading<number> {
  if (raw === undefined || !/^\d+$/.test(raw)) return absent(now);
  const n = Number(raw);
  if (raw.length <= 3 && n >= 252) return absent(now);
  if (raw.length === 5 && n >= 65532) return absent(now);
  return ok(transform(n), now);
}

function text(raw: string | undefined, now: number): Reading<string> {
  const v = raw?.trim();
  if (!v || v === 'UNKN' || v === 'UNKNOWN') return absent(now);
  return ok(v, now);
}

function flag(raw: string | undefined, now: number, trueValues: string[], falseValues: string[]): Reading<boolean> {
  if (raw !== undefined && trueValues.includes(raw)) return ok(true, now);
  if (raw !== undefined && falseValues.includes(raw)) return ok(false, now);
  return absent(now);
}

/** RSSI/audio fields encoded as `value - offset`; 3-digit sentinels still apply. */
function offset(raw: string | undefined, now: number, by: number): Reading<number> {
  return numeric(raw, now, (n) => n - by);
}

/**
 * Audio meter calibration in dB, added on top of each family's documented
 * conversion. Raised 8 dB because meters read low against Wireless Workbench
 * on real receivers (2026-10-14). Provisional until a side-by-side capture
 * pins the exact offset per family; see docs/shure-protocol.md.
 */
export const AUDIO_TRIM_DB = 8;

/** An audio meter field in dBFS: documented offset, plus the trim, never above full scale. */
function audioLevel(raw: string | undefined, now: number, by: number): Reading<number> {
  return numeric(raw, now, (n) => Math.min(0, n - by + AUDIO_TRIM_DB));
}

// ---- shared report handlers ---------------------------------------------

const name: Apply = (t, a, now) => { t.name = text(a.join(' '), now); };
const frequency: Apply = (t, a, now) => { t.frequencyKhz = numeric(a[0], now); };
const groupChannel: Apply = (t, a, now) => {
  const v = a.join(' ').trim();
  t.groupChannel = v && !v.startsWith('--') ? ok(v, now) : absent(now);
};
const rxMute: Apply = (t, a, now) => { t.rxMuted = flag(a[0], now, ['ON'], ['OFF']); };
const bars: Apply = (t, a, now) => { t.batteryBars = numeric(a[0], now); };
const percent: Apply = (t, a, now) => { t.batteryPercent = numeric(a[0], now); };
// 65534 means the transmitter is still working out its runtime: seen on an AD2
// for at least 30 s after power-on with a full battery.
const runtime: Apply = (t, a, now) => {
  t.batteryRuntimeMin = a[0] === '65534' ? absent(now, 'calculating') : numeric(a[0], now);
};
const battType: Apply = (t, a, now) => { t.batteryType = text(a[0], now); };
const health: Apply = (t, a, now) => { t.batteryHealthPercent = numeric(a[0], now); };
const cycles: Apply = (t, a, now) => { t.batteryCycles = numeric(a[0], now); };
// Encoded as °C + 40; confirmed on an AD2, where TX_BATT_TEMP_F (°F + 40) agrees.
const tempC: Apply = (t, a, now) => { t.batteryTempC = offset(a[0], now, 40); };
const txModel: Apply = (t, a, now) => { t.txModel = text(a[0], now); };
const txDeviceId: Apply = (t, a, now) => { t.txDeviceId = text(a.join(' '), now); };

// ---- ULX-D ---------------------------------------------------------------

const ulxd: ShureFamily = {
  id: 'ulxd',
  label: 'Shure ULX-D',
  role: 'mic',
  defaultChannels: 4,
  deviceIdKey: 'DEVICE_ID',
  defaultPort: 2202,
  getAll: true,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'groupChannel', 'txModel', 'txDeviceId', 'txOffsetDb', 'txMuted',
    'batteryBars', 'batteryPercent', 'batteryRuntimeMin', 'batteryType',
    'batteryHealthPercent', 'batteryCycles', 'batteryTempC',
    'rfDbm', 'antennas', 'audioRmsDbfs', 'rxMuted', 'interference', 'encryptionFault',
  ]),
  reports: {
    CHAN_NAME: name,
    FREQUENCY: frequency,
    GROUP_CHAN: groupChannel,
    AUDIO_MUTE: rxMute,
    BATT_BARS: bars,
    BATT_CHARGE: percent,
    BATT_RUN_TIME: runtime,
    BATT_TYPE: battType,
    BATT_HEALTH: health,
    BATT_CYCLE: cycles,
    BATT_TEMP_C: tempC,
    // The 2018 bulletin says only ULXD6/ULXD8 report identity and mute, but a
    // ULXD1 on current firmware reports TX_MUTE_STATUS (and a TX_DEVICE_ID), so
    // take whatever the transmitter sends rather than ruling fields out by model.
    TX_TYPE: txModel,
    TX_DEVICE_ID: txDeviceId,
    TX_OFFSET: (t, a, now) => { t.txOffsetDb = numeric(a[0], now); },
    TX_MUTE_STATUS: (t, a, now) => { t.txMuted = flag(a[0], now, ['ON'], ['OFF']); },
    RF_INT_DET: (t, a, now) => { t.interference = flag(a[0], now, ['CRITICAL'], ['NONE']); },
    ENCRYPTION_WARNING: (t, a, now) => { t.encryptionFault = flag(a[0], now, ['ON'], ['OFF']); },
  },
  poll: ['BATT_BARS', 'BATT_CHARGE', 'BATT_RUN_TIME', 'TX_TYPE', 'TX_OFFSET', 'AUDIO_MUTE', 'RF_INT_DET', 'ENCRYPTION_WARNING'],
  // < SAMPLE x ALL nn aaa eee >  nn: AX/XB/XX, aaa: RF 0-115 (dBm = aaa-128), eee: audio 0-50
  applySample: (t, a, now) => {
    const [ant, rf, audio] = a;
    t.antennas = ant ? ok(ant, now) : absent(now);
    const rssi = offset(rf, now, 128);
    t.rfDbm = rssi.state === 'ok' ? ok([rssi.value], now) : absent(now);
    t.audioRmsDbfs = audioLevel(audio, now, 50);
  },
};

// ---- Axient Digital --------------------------------------------------------

const axd: ShureFamily = {
  id: 'axd',
  label: 'Shure Axient Digital',
  role: 'mic',
  defaultChannels: 4,
  deviceIdKey: 'DEVICE_ID',
  defaultPort: 2202,
  getAll: true,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'groupChannel', 'txModel', 'txDeviceId', 'txOffsetDb', 'txMuted',
    'batteryBars', 'batteryPercent', 'batteryRuntimeMin', 'batteryType',
    'batteryHealthPercent', 'batteryCycles', 'batteryTempC',
    'rfDbm', 'antennas', 'audioRmsDbfs', 'audioPeakDbfs', 'linkQuality',
    'rxMuted', 'interference', 'encryptionFault', 'unregisteredTx', 'txTalkSwitch',
  ]),
  reports: {
    CHAN_NAME: name,
    FREQUENCY: frequency,
    GROUP_CHANNEL: groupChannel,
    AUDIO_MUTE: rxMute,
    TX_BATT_BARS: bars,
    TX_BATT_CHARGE_PERCENT: percent,
    TX_BATT_MINS: runtime,
    TX_BATT_TYPE: battType,
    TX_BATT_HEALTH_PERCENT: health,
    TX_BATT_CYCLE_COUNT: cycles,
    TX_BATT_TEMP_C: tempC,
    TX_MODEL: txModel,
    TX_DEVICE_ID: txDeviceId,
    TX_OFFSET: (t, a, now) => { t.txOffsetDb = offset(a[0], now, 12); },
    TX_MUTE_MODE_STATUS: (t, a, now) => { t.txMuted = flag(a[0], now, ['MUTE'], ['ON']); },
    INTERFERENCE_STATUS: (t, a, now) => { t.interference = flag(a[0], now, ['DETECTED'], ['NONE']); },
    ENCRYPTION_STATUS: (t, a, now) => { t.encryptionFault = flag(a[0], now, ['ERROR'], ['OK']); },
    UNREGISTERED_TX_STATUS: (t, a, now) => { t.unregisteredTx = flag(a[0], now, ['ERROR'], ['OK']); },
    // Reported on press and release (ADX2); AD1/AD2 without a talk switch report OFF.
    TX_TALK_SWITCH: (t, a, now) => { t.txTalkSwitch = flag(a[0], now, ['ON'], ['OFF']); },
  },
  // TX_TALK_SWITCH is polled so a missed release can't leave TALK showing.
  poll: ['TX_BATT_BARS', 'TX_BATT_CHARGE_PERCENT', 'TX_BATT_MINS', 'TX_MODEL', 'TX_DEVICE_ID', 'TX_OFFSET', 'AUDIO_MUTE', 'INTERFERENCE_STATUS', 'ENCRYPTION_STATUS', 'UNREGISTERED_TX_STATUS', 'TX_TALK_SWITCH'],
  // < SAMPLE x ALL qual audBitmap audPeak audRms ant (bitmap rssi)×N [ant2 (bitmap rssi)×N] >
  // N = ant.length (2, or 4 with Quadversity). The second block exists only in FD-C mode.
  applySample: (t, a, now) => {
    const [qual, , peak, rms, ant] = a;
    t.linkQuality = numeric(qual, now);
    t.audioPeakDbfs = audioLevel(peak, now, 120);
    t.audioRmsDbfs = audioLevel(rms, now, 120);
    if (!ant) {
      t.antennas = absent(now);
      t.rfDbm = absent(now);
      return;
    }
    t.antennas = ok(ant, now);
    const rssi: number[] = [];
    for (let i = 0; i < ant.length; i++) {
      const r = offset(a[6 + i * 2], now, 120);
      if (r.state !== 'ok') {
        t.rfDbm = absent(now);
        return;
      }
      rssi.push(r.value);
    }
    t.rfDbm = ok(rssi, now);
  },
};

// ---- SLX-D ---------------------------------------------------------------
// Our copy of the SLX-D document is incomplete; capabilities are provisional.

const slxd: ShureFamily = {
  id: 'slxd',
  label: 'Shure SLX-D',
  role: 'mic',
  defaultChannels: 2,
  deviceIdKey: 'DEVICE_ID',
  defaultPort: 2202,
  getAll: true,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'groupChannel', 'txModel',
    'batteryBars', 'batteryPercent', 'batteryRuntimeMin', 'batteryType',
    'rfDbm', 'audioRmsDbfs', 'audioPeakDbfs', 'rxMuted',
  ]),
  reports: {
    CHAN_NAME: name,
    FREQUENCY: frequency,
    GROUP_CHANNEL: groupChannel,
    AUDIO_MUTE: rxMute,
    TX_BATT_BARS: bars,
    TX_BATT_CHARGE_PERCENT: percent,
    TX_BATT_MINS: runtime,
    TX_BATT_TYPE: battType,
    TX_MODEL: txModel,
  },
  poll: ['TX_BATT_BARS', 'TX_BATT_MINS', 'TX_MODEL', 'AUDIO_MUTE'],
  // < SAMPLE x ALL audPeak audRms rssi >, all encoded as value - 120
  applySample: (t, a, now) => {
    const [peak, rms, rf] = a;
    t.audioPeakDbfs = audioLevel(peak, now, 120);
    t.audioRmsDbfs = audioLevel(rms, now, 120);
    const rssi = offset(rf, now, 120);
    t.rfDbm = rssi.state === 'ok' ? ok([rssi.value], now) : absent(now);
  },
};

// ---- PSM 1000 (P10T) ------------------------------------------------------
// An in-ear monitor transmitter: two channels, each sending to receive-only
// P10R/P10R+ bodypacks, so nothing about the packs is visible. Key names come
// from Shure's PSM1000 command strings and bitfocus companion-module-shure-psm1000
// (MIT, (c) 2020 Bitfocus AS); value encodings are provisional until checked
// against hardware, so parsers accept both the numeric and word forms.

const AUDIO_MODES: Record<string, string> = { '1': 'Mono', '2': 'Point to point', '3': 'Stereo' };

const psm1000: ShureFamily = {
  id: 'psm1000',
  label: 'Shure PSM 1000',
  role: 'iem',
  defaultChannels: 2,
  deviceIdKey: 'DEVICE_NAME',
  // Shure's PSM1000 command strings give port 2201, not the receivers' 2202.
  defaultPort: 2201,
  getAll: false,
  supports: new Set<Metric>(['name', 'frequencyKhz', 'groupChannel', 'rfOutputMw', 'rfMuted', 'audioMode']),
  reports: {
    CHAN_NAME: name,
    FREQUENCY: frequency,
    GROUP_CHAN: groupChannel,
    // 10, 50 or 100 mW, possibly zero-padded; anything else (e.g. OFF) means no RF.
    RF_TX_LVL: (t, a, now) => {
      const raw = a[0];
      t.rfOutputMw = raw === undefined ? absent(now) : /^\d+$/.test(raw) ? ok(Number(raw), now) : raw === 'OFF' ? ok(0, now) : absent(now);
    },
    RF_MUTE: (t, a, now) => { t.rfMuted = flag(a[0], now, ['1', 'ON'], ['0', 'OFF']); },
    AUDIO_TX_MODE: (t, a, now) => {
      const raw = a.join(' ').trim();
      t.audioMode = raw ? ok(AUDIO_MODES[raw] ?? raw, now) : absent(now);
    },
  },
  poll: ['RF_TX_LVL', 'RF_MUTE', 'AUDIO_TX_MODE', 'FREQUENCY'],
  // The PSM1000 SAMPLE layout is undocumented in our sources; samples only
  // keep the link alive until it is captured from hardware.
  applySample: () => {},
};

export const SHURE_FAMILIES: Readonly<Record<ShureFamilyId, ShureFamily>> = { ulxd, axd, slxd, psm1000 };

export const SHURE_FAMILY_IDS = Object.keys(SHURE_FAMILIES) as ShureFamilyId[];

/** Fresh telemetry for a channel of `family`, with unsupported metrics marked as such. */
export function initialTelemetry(family: ShureFamily): ChannelTelemetry {
  const t = emptyTelemetry();
  for (const key of Object.keys(t) as Metric[]) {
    if (!family.supports.has(key)) (t as Record<Metric, Reading<unknown>>)[key] = UNSUPPORTED;
  }
  return t;
}
