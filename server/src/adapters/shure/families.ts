/**
 * Per-family mapping from Shure command strings to RF Ranger telemetry.
 *
 * Field names, sample layouts, offsets and sentinels come from Shure's
 * published command-string documents, cross-checked against Micboard
 * (MIT, (c) 2019 Karl Swanson) and bitfocus companion-module-shure-wireless
 * (MIT, (c) 2019 Joseph Adams). See NOTICE and docs/shure-protocol.md.
 */
import { emptyTelemetry, type ChannelTelemetry, type Metric } from '../../core/model.js';
import { absent, ok, UNSUPPORTED, type Reading } from '../../core/reading.js';

export type ShureFamilyId = 'ulxd' | 'axd' | 'slxd';

type Apply = (t: ChannelTelemetry, args: string[], now: number) => void;

export interface ShureFamily {
  id: ShureFamilyId;
  label: string;
  defaultChannels: number;
  /** Metrics this family can report. Everything else starts as `unsupported`. */
  supports: ReadonlySet<Metric>;
  reports: Readonly<Record<string, Apply>>;
  applySample: Apply;
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
const runtime: Apply = (t, a, now) => { t.batteryRuntimeMin = numeric(a[0], now); };
const battType: Apply = (t, a, now) => { t.batteryType = text(a[0], now); };
const txModel: Apply = (t, a, now) => { t.txModel = text(a[0], now); };
const txDeviceId: Apply = (t, a, now) => { t.txDeviceId = text(a.join(' '), now); };

// ---- ULX-D ---------------------------------------------------------------

const ULXD_ID_CAPABLE = new Set(['ULXD6', 'ULXD8']);

const ulxd: ShureFamily = {
  id: 'ulxd',
  label: 'Shure ULX-D',
  defaultChannels: 4,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'groupChannel', 'txModel', 'txDeviceId', 'txOffsetDb', 'txMuted',
    'batteryBars', 'batteryPercent', 'batteryRuntimeMin', 'batteryType',
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
    TX_TYPE: (t, a, now) => {
      t.txModel = text(a[0], now);
      // Only bodypack ULXD6 / boundary ULXD8 report an identity and mute state.
      if (t.txModel.state === 'ok' && !ULXD_ID_CAPABLE.has(t.txModel.value)) {
        t.txDeviceId = UNSUPPORTED;
        t.txMuted = UNSUPPORTED;
      }
    },
    TX_DEVICE_ID: txDeviceId,
    TX_OFFSET: (t, a, now) => { t.txOffsetDb = numeric(a[0], now); },
    TX_MUTE_STATUS: (t, a, now) => { t.txMuted = flag(a[0], now, ['ON'], ['OFF']); },
    RF_INT_DET: (t, a, now) => { t.interference = flag(a[0], now, ['CRITICAL'], ['NONE']); },
    ENCRYPTION_WARNING: (t, a, now) => { t.encryptionFault = flag(a[0], now, ['ON'], ['OFF']); },
  },
  // < SAMPLE x ALL nn aaa eee >  nn: AX/XB/XX, aaa: RF 0-115 (dBm = aaa-128), eee: audio 0-50
  applySample: (t, a, now) => {
    const [ant, rf, audio] = a;
    t.antennas = ant ? ok(ant, now) : absent(now);
    const rssi = offset(rf, now, 128);
    t.rfDbm = rssi.state === 'ok' ? ok([rssi.value], now) : absent(now);
    t.audioRmsDbfs = offset(audio, now, 50);
  },
};

// ---- Axient Digital --------------------------------------------------------

const axd: ShureFamily = {
  id: 'axd',
  label: 'Shure Axient Digital',
  defaultChannels: 4,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'groupChannel', 'txModel', 'txDeviceId', 'txOffsetDb', 'txMuted',
    'batteryBars', 'batteryPercent', 'batteryRuntimeMin', 'batteryType',
    'rfDbm', 'antennas', 'audioRmsDbfs', 'audioPeakDbfs', 'linkQuality',
    'rxMuted', 'interference', 'encryptionFault', 'unregisteredTx',
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
    TX_DEVICE_ID: txDeviceId,
    TX_OFFSET: (t, a, now) => { t.txOffsetDb = offset(a[0], now, 12); },
    TX_MUTE_MODE_STATUS: (t, a, now) => { t.txMuted = flag(a[0], now, ['MUTE'], ['ON']); },
    INTERFERENCE_STATUS: (t, a, now) => { t.interference = flag(a[0], now, ['DETECTED'], ['NONE']); },
    ENCRYPTION_STATUS: (t, a, now) => { t.encryptionFault = flag(a[0], now, ['ERROR'], ['OK']); },
    UNREGISTERED_TX_STATUS: (t, a, now) => { t.unregisteredTx = flag(a[0], now, ['ERROR'], ['OK']); },
  },
  // < SAMPLE x ALL qual audBitmap audPeak audRms ant (bitmap rssi)×N [ant2 (bitmap rssi)×N] >
  // N = ant.length (2, or 4 with Quadversity). The second block exists only in FD-C mode.
  applySample: (t, a, now) => {
    const [qual, , peak, rms, ant] = a;
    t.linkQuality = numeric(qual, now);
    t.audioPeakDbfs = offset(peak, now, 120);
    t.audioRmsDbfs = offset(rms, now, 120);
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
  defaultChannels: 2,
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
  // < SAMPLE x ALL audPeak audRms rssi >, all encoded as value - 120
  applySample: (t, a, now) => {
    const [peak, rms, rf] = a;
    t.audioPeakDbfs = offset(peak, now, 120);
    t.audioRmsDbfs = offset(rms, now, 120);
    const rssi = offset(rf, now, 120);
    t.rfDbm = rssi.state === 'ok' ? ok([rssi.value], now) : absent(now);
  },
};

export const SHURE_FAMILIES: Readonly<Record<ShureFamilyId, ShureFamily>> = { ulxd, axd, slxd };

/** Fresh telemetry for a channel of `family`, with unsupported metrics marked as such. */
export function initialTelemetry(family: ShureFamily): ChannelTelemetry {
  const t = emptyTelemetry();
  for (const key of Object.keys(t) as Metric[]) {
    if (!family.supports.has(key)) (t as Record<Metric, Reading<unknown>>)[key] = UNSUPPORTED;
  }
  return t;
}
