/**
 * Sennheiser receiver families over SSC v1: what to ask for and how each
 * address maps onto RF Ranger's normalised telemetry. Paths and value
 * formats follow Sennheiser's SSC developer guides; anything marked
 * "unconfirmed" still needs a capture from real hardware (a device report).
 */
import type { ChannelTelemetry, Metric } from '../../core/model.js';
import { emptyTelemetry } from '../../core/model.js';
import { UNSUPPORTED, absent, ok, type Reading } from '../../core/reading.js';
import { merge, tree, type SscValue } from './ssc.js';

export type SennheiserFamilyId = 'ewdx' | 'd6000';

export interface SennheiserFamily {
  id: SennheiserFamilyId;
  label: string;
  role: 'mic';
  defaultChannels: number;
  supports: ReadonlySet<Metric>;
  /** Everything worth reading once (on connect and periodically) for channel n. */
  read(n: number): Record<string, SscValue>;
  /** Values reported on change, subscribed for all channels. */
  onChange(channels: number[]): Record<string, SscValue>;
  /** Meter addresses, subscribed with a fixed notification interval. */
  meters(channels: number[]): Record<string, SscValue>;
  /** Apply one value to the channel it belongs to; returns that channel, if any. */
  apply(path: string, value: SscValue, channel: (n: number) => ChannelTelemetry | undefined, now: number): number | number[] | undefined;
  /**
   * Whether this value means a channel should be read again in full, e.g. a
   * transmitter has just been paired after its addresses answered 424.
   */
  rereadOn?(path: string, value: SscValue, t: ChannelTelemetry): boolean;
  /** An address the device answered with an error: e.g. 424 for transmitter data while none is on. */
  applyError(path: string, code: number, channel: (n: number) => ChannelTelemetry | undefined, now: number): number | undefined;
}

const str = (v: SscValue): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
const num = (v: SscValue): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Readings that come from the transmitter, which go absent together when it switches off. */
const TX_METRICS: Metric[] = ['txModel', 'txDeviceId', 'txMuted', 'batteryBars', 'batteryPercent', 'batteryRuntimeMin', 'batteryType', 'linkQuality'];

function txGone(t: ChannelTelemetry, now: number): void {
  for (const m of TX_METRICS) if (t[m].state !== 'unsupported') (t as Record<Metric, Reading<unknown>>)[m] = absent(now);
}

/** Warning lists: apply the ones RF Ranger models. */
function warnings(t: ChannelTelemetry, list: SscValue, now: number): void {
  const w = Array.isArray(list) ? list.map((x) => String(x).toLowerCase()) : [];
  t.encryptionFault = ok(w.includes('aes256error'), now);
  t.interference = ok(false, now); // SSC v1 reports no interference flag
  if (w.includes('nolink')) txGone(t, now);
}

function channelOf(path: string, prefix: string): number | undefined {
  const m = new RegExp(`^/${prefix}(\\d+)/`).exec(path);
  return m ? Number(m[1]) : undefined;
}

// ---- EW-DX (EM 2, EM 4) -------------------------------------------------------

const ewdx: SennheiserFamily = {
  id: 'ewdx',
  label: 'Sennheiser EW-DX',
  role: 'mic',
  defaultChannels: 2,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'txModel', 'txDeviceId', 'txMuted', 'batteryPercent', 'batteryRuntimeMin', 'batteryType',
    'rfDbm', 'antennas', 'audioRmsDbfs', 'linkQuality', 'rxMuted', 'interference', 'encryptionFault',
  ]),
  read: (n) => merge(
    tree([`rx${n}`, 'name']), tree([`rx${n}`, 'frequency']), tree([`rx${n}`, 'mute']), tree([`rx${n}`, 'warnings']), tree([`rx${n}`, 'mates']),
    tree(['mates', `tx${n}`, 'type']), tree(['mates', `tx${n}`, 'name']), tree(['mates', `tx${n}`, 'mute']), tree(['mates', `tx${n}`, 'warnings']),
    tree(['mates', `tx${n}`, 'battery', 'gauge']), tree(['mates', `tx${n}`, 'battery', 'lifetime']), tree(['mates', `tx${n}`, 'battery', 'type']),
  ),
  onChange: (chs) => merge(...chs.flatMap((n) => [
    tree([`rx${n}`, 'name']), tree([`rx${n}`, 'frequency']), tree([`rx${n}`, 'mute']), tree([`rx${n}`, 'warnings']), tree([`rx${n}`, 'mates']),
    tree(['mates', `tx${n}`, 'battery', 'gauge']), tree(['mates', `tx${n}`, 'battery', 'lifetime']), tree(['mates', `tx${n}`, 'mute']),
    tree(['mates', `tx${n}`, 'type']), tree(['mates', `tx${n}`, 'warnings']),
  ])),
  meters: (chs) => merge(...chs.flatMap((n) => [tree(['m', `rx${n}`, 'rssi']), tree(['m', `rx${n}`, 'rsqi']), tree(['m', `rx${n}`, 'divi']), tree(['m', `rx${n}`, 'af'])])),

  apply(path, v, channel, now) {
    let n = channelOf(path, 'rx');
    if (n !== undefined) {
      const t = channel(n);
      if (!t) return undefined;
      if (path.endsWith('/name')) t.name = str(v) ? ok(str(v)!, now) : absent(now);
      else if (path.endsWith('/frequency')) t.frequencyKhz = num(v) !== undefined ? ok(num(v)!, now) : absent(now);
      else if (path.endsWith('/mute')) t.rxMuted = typeof v === 'boolean' ? ok(v, now) : absent(now);
      else if (path.endsWith('/warnings')) warnings(t, v, now);
      else if (path.endsWith('/mates')) { if (Array.isArray(v) && v.length === 0) txGone(t, now); }
      else return undefined;
      return n;
    }
    n = channelOf(path, 'm/rx');
    if (n !== undefined) {
      const t = channel(n);
      if (!t) return undefined;
      if (path.endsWith('/rssi')) t.rfDbm = num(v) !== undefined ? ok([Math.round(num(v)!)], now) : absent(now);
      else if (path.endsWith('/divi')) t.antennas = num(v) === 1 ? ok('AX', now) : num(v) === 2 ? ok('XB', now) : ok('XX', now);
      // RF signal quality 0–100 %, shown on RF Ranger's 0–5 link-quality scale. Meters keep
      // coming with no transmitter on; there's no link to rate then.
      else if (path.endsWith('/rsqi')) t.linkQuality = num(v) !== undefined && t.txModel.state !== 'absent' ? ok(Math.round(num(v)! / 20), now) : absent(now);
      else if (path.endsWith('/af')) t.audioRmsDbfs = num(v) !== undefined ? ok(Math.round(num(v)!), now) : absent(now);
      else return undefined;
      return n;
    }
    n = channelOf(path, 'mates/tx');
    if (n !== undefined) {
      const t = channel(n);
      if (!t) return undefined;
      if (path.endsWith('/battery/gauge')) t.batteryPercent = num(v) !== undefined ? ok(num(v)!, now) : absent(now);
      else if (path.endsWith('/battery/lifetime')) t.batteryRuntimeMin = num(v) !== undefined ? ok(num(v)!, now) : absent(now);
      else if (path.endsWith('/battery/type')) t.batteryType = str(v) ? ok(str(v) === 'Primary Cell' ? 'AA' : 'Rechargeable', now) : absent(now);
      else if (path.endsWith('/type')) t.txModel = str(v) ? ok(str(v)!, now) : absent(now);
      else if (path.endsWith('/name')) t.txDeviceId = str(v) ? ok(str(v)!, now) : absent(now);
      else if (path.endsWith('/mute')) t.txMuted = typeof v === 'boolean' ? ok(v, now) : absent(now);
      else if (path.endsWith('/warnings')) { /* LowBattery and AfPeak: the gauge and meters already show them */ }
      else return undefined;
      return n;
    }
    return undefined;
  },

  rereadOn: (path, v, t) => /^\/rx\d+\/mates$/.test(path) && Array.isArray(v) && v.length > 0 && t.txModel.state !== 'ok',

  applyError(path, code, channel, now) {
    // 424: "TX is not present or doesn't send valid information".
    const n = channelOf(path, 'mates/tx');
    if (n === undefined || code !== 424) return undefined;
    const t = channel(n);
    if (!t) return undefined;
    txGone(t, now);
    return n;
  },
};

// ---- Digital 6000 (EM 6000) ---------------------------------------------------

/** "70%" / "low" battery states, as transmitter-style bars (D6000 reports no exact percentage). */
const D6000_BARS: Record<string, number> = { '100%': 5, '70%': 4, '30%': 2, low: 1 };

const d6000: SennheiserFamily = {
  id: 'd6000',
  label: 'Sennheiser Digital 6000',
  role: 'mic',
  defaultChannels: 2,
  supports: new Set<Metric>([
    'name', 'frequencyKhz', 'txModel', 'txDeviceId', 'batteryBars', 'batteryRuntimeMin',
    'rfDbm', 'antennas', 'audioRmsDbfs', 'audioPeakDbfs', 'linkQuality', 'rxMuted', 'interference', 'encryptionFault',
  ]),
  read: (n) => merge(
    tree([`rx${n}`, 'name']), tree([`rx${n}`, 'carrier']), tree([`rx${n}`, 'audio_mute']), tree([`rx${n}`, 'active_warnings']),
    tree([`rx${n}`, 'skx', 'type']), tree([`rx${n}`, 'skx', 'name']), tree([`rx${n}`, 'skx', 'battery']),
  ),
  onChange: (chs) => merge(...chs.flatMap((n) => [
    tree([`rx${n}`, 'name']), tree([`rx${n}`, 'carrier']), tree([`rx${n}`, 'audio_mute']), tree([`rx${n}`, 'active_warnings']),
    tree([`rx${n}`, 'skx', 'type']), tree([`rx${n}`, 'skx', 'name']), tree([`rx${n}`, 'skx', 'battery']),
  ])),
  meters: () => tree(['mm']),

  apply(path, v, channel, now) {
    if (path === '/mm') {
      if (!Array.isArray(v)) return undefined;
      const touched: number[] = [];
      v.forEach((row, i) => {
        const t = channel(i + 1);
        if (!t || !Array.isArray(row) || row.length < 9) return;
        const [rf1, , rf2, , div1, div2, lqi, af, afPeak] = row.map((x) => (typeof x === 'number' ? x : NaN));
        const present = t.txModel.state === 'ok';
        // dBm = (value - 255) / 2; dBFS = (value + 1) / 2 - 128 (Digital 6000 guide, /mm).
        t.rfDbm = Number.isFinite(rf1) && Number.isFinite(rf2) ? ok([Math.round((rf1! - 255) / 2), Math.round((rf2! - 255) / 2)], now) : absent(now);
        t.antennas = ok(`${div1 ? 'A' : 'X'}${div2 ? 'B' : 'X'}`, now);
        t.linkQuality = present && Number.isFinite(lqi) ? ok(Math.round((lqi! / 255) * 5), now) : absent(now);
        t.audioRmsDbfs = Number.isFinite(af) ? ok(Math.round((af! + 1) / 2 - 128), now) : absent(now);
        // Only a clip flag (digital clip for at least a second), so peak reads full scale while it's set.
        t.audioPeakDbfs = Number.isFinite(af) ? ok(afPeak ? 0 : Math.round((af! + 1) / 2 - 128), now) : absent(now);
        touched.push(i + 1);
      });
      return touched;
    }
    const n = channelOf(path, 'rx');
    if (n === undefined) return undefined;
    const t = channel(n);
    if (!t) return undefined;
    if (path.endsWith('/skx/type')) {
      // ["SK A1-A4","470 MHz","558 MHz"], or empty when no transmitter is on.
      const model = Array.isArray(v) ? str(v[0] ?? null) : str(v);
      if (model) t.txModel = ok(model, now);
      else txGone(t, now);
    } else if (path.endsWith('/skx/name')) {
      t.txDeviceId = str(v) ? ok(str(v)!, now) : absent(now);
    } else if (path.endsWith('/skx/battery')) {
      // ["70%","5:12"]: state and h:mm, "-:--" when unknown; [] when no transmitter.
      if (!Array.isArray(v) || v.length < 1) {
        t.batteryBars = absent(now);
        t.batteryRuntimeMin = absent(now);
      } else {
        const bars = D6000_BARS[String(v[0])];
        t.batteryBars = bars !== undefined ? ok(bars, now) : absent(now);
        const m = /^(\d+):(\d\d)$/.exec(String(v[1] ?? ''));
        t.batteryRuntimeMin = m ? ok(Number(m[1]) * 60 + Number(m[2]), now) : absent(now, 'calculating');
      }
    } else if (path.endsWith('/name')) {
      t.name = str(v) ? ok(str(v)!, now) : absent(now);
    } else if (path.endsWith('/carrier')) {
      t.frequencyKhz = num(v) !== undefined ? ok(num(v)!, now) : absent(now);
    } else if (path.endsWith('/audio_mute')) {
      t.rxMuted = typeof v === 'boolean' ? ok(v, now) : absent(now);
    } else if (path.endsWith('/active_warnings')) {
      warnings(t, v, now);
    } else {
      return undefined;
    }
    return n;
  },

  applyError: () => undefined,
};

export const SENNHEISER_FAMILIES: Record<SennheiserFamilyId, SennheiserFamily> = { ewdx, d6000 };
export const SENNHEISER_FAMILY_IDS = Object.keys(SENNHEISER_FAMILIES) as SennheiserFamilyId[];

export function initialTelemetry(family: SennheiserFamily): ChannelTelemetry {
  const t = emptyTelemetry();
  for (const key of Object.keys(t) as Metric[]) {
    if (!family.supports.has(key)) (t as Record<Metric, Reading<unknown>>)[key] = UNSUPPORTED;
  }
  return t;
}

/**
 * Product label → family and channel count. EW-DX labels are unconfirmed
 * (the guide documents none); anything containing "EM 4" / "EM4" is taken as
 * four channels.
 */
export function familyForProduct(product: string): { family: SennheiserFamilyId; channels: number } | { unsupported: string } {
  const p = product.trim();
  if (/EM\s?6000/i.test(p)) return { family: 'd6000', channels: 2 };
  if (/EW-?DX/i.test(p) || /^EM\s?[24]\b/i.test(p)) return { family: 'ewdx', channels: /EM\s?4/i.test(p) ? 4 : 2 };
  if (/CHG\s?70N/i.test(p)) return { unsupported: 'Sennheiser CHG 70N chargers are not supported yet' };
  return { unsupported: `Unrecognised Sennheiser product "${p}"` };
}
