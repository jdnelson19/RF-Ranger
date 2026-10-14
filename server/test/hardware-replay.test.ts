/**
 * Replays captures from real hardware (Device Inspector reports, anonymized)
 * through the same parsing the live receiver uses, at their original
 * timestamps. These pin down behaviour that simulators can only guess at.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHURE_FAMILIES, initialTelemetry, type ShureFamilyId } from '../src/adapters/shure/families.js';
import { parseMessage } from '../src/adapters/shure/protocol.js';
import { channelAlerts } from '../src/core/alerts.js';
import type { ChannelTelemetry, ConnectionStatus } from '../src/core/model.js';
import { readiness, txPresent } from '../src/core/readiness.js';
import { DEFAULT_ALERT_THRESHOLDS } from '../src/server/config.js';

interface Report {
  frames: Array<{ t: number; dir: 'in' | 'out' | 'note'; frame: string }>;
}

function load(name: string): Report {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Report;
}

/** Feed incoming frames; `onFrame` sees the state after each one. */
function replay(report: Report, family: ShureFamilyId, onFrame?: (t: number, frame: string, ch: Map<number, ChannelTelemetry>) => void) {
  const fam = SHURE_FAMILIES[family];
  const channels = new Map<number, ChannelTelemetry>();
  const get = (n: number) => {
    if (!channels.has(n)) channels.set(n, initialTelemetry(fam));
    return channels.get(n)!;
  };
  let last = 0;
  for (const f of report.frames) {
    if (f.dir !== 'in') continue;
    last = f.t;
    const m = parseMessage(f.frame);
    if (m.kind === 'sample') fam.applySample(get(m.channel), m.args, f.t);
    else if (m.kind === 'rep' && m.channel !== undefined) fam.reports[m.key]?.(get(m.channel), m.args, f.t);
    onFrame?.(f.t, f.frame, channels);
  }
  return { channels, last };
}

describe('AD4Q-A with an AD2 switched on mid-capture', () => {
  const report = load('ad4q-ad2-power-on.json');
  const firstOnSample = report.frames.find((f) => /^< SAMPLE 1 ALL (?!255)/.test(f.frame))!;
  const powerOn = firstOnSample.t;
  const modelAt = report.frames.find((f) => f.frame === '< REP 1 TX_MODEL AD2 >')!.t;
  /** While on air the AD RMS meter bottoms out at -87 dBFS (raw 033); peak keeps falling below it in silence. */
  const RMS_FLOOR_DBFS = -87;

  it('sees the transmitter come on from the first sample, before its reports arrive', () => {
    const presence: Array<{ t: number; frame: string; on: boolean }> = [];
    replay(report, 'axd', (t, frame, ch) => { if (ch.has(1)) presence.push({ t, frame, on: txPresent(ch.get(1)!) }); });
    const at = presence.findIndex((p) => p.frame === firstOnSample.frame && p.t === powerOn);
    expect(presence.slice(0, at).every((p) => !p.on)).toBe(true);
    expect(presence.slice(at).every((p) => p.on)).toBe(true);
    expect(modelAt - powerOn).toBeGreaterThan(1_000);
  });

  it('reads the AD2 and its battery as the receiver reports them', () => {
    const t = replay(report, 'axd').channels.get(1)!;
    expect(t.txModel).toMatchObject({ state: 'ok', value: 'AD2' });
    expect(t.batteryBars).toMatchObject({ state: 'ok', value: 5 });
    expect(t.batteryPercent).toMatchObject({ state: 'ok', value: 100 });
    expect(t.batteryType).toMatchObject({ state: 'ok', value: 'LION' });
    expect(t.batteryRuntimeMin).toMatchObject({ state: 'absent', reason: 'calculating' });
    expect(t.batteryHealthPercent).toMatchObject({ state: 'ok', value: 89 });
    expect(t.batteryCycles).toMatchObject({ state: 'ok', value: 301 });
    expect(t.batteryTempC).toMatchObject({ state: 'ok', value: 23 });
    expect(t.txOffsetDb).toMatchObject({ state: 'ok', value: 0 });
    expect(t.txMuted).toMatchObject({ state: 'ok', value: false });
    expect(t.linkQuality).toMatchObject({ state: 'ok', value: 5 });
    expect(t.antennas).toMatchObject({ state: 'ok', value: 'BB' });
  });

  it('gets plausible RF and audio: peak at or above RMS whenever there is sound', () => {
    let samples = 0;
    let withSound = 0;
    replay(report, 'axd', (t, frame, ch) => {
      if (t < powerOn || !frame.startsWith('< SAMPLE 1 ')) return;
      const c = ch.get(1)!;
      if (c.rfDbm.state !== 'ok' || c.audioPeakDbfs.state !== 'ok' || c.audioRmsDbfs.state !== 'ok') return;
      samples++;
      expect(c.rfDbm.value).toHaveLength(2);
      for (const dbm of c.rfDbm.value) expect(dbm).toBeGreaterThan(-90);
      expect(c.audioRmsDbfs.value).toBeGreaterThanOrEqual(RMS_FLOOR_DBFS);
      if (c.audioRmsDbfs.value > RMS_FLOOR_DBFS) {
        withSound++;
        expect(c.audioPeakDbfs.value).toBeGreaterThanOrEqual(c.audioRmsDbfs.value);
      }
    });
    expect(samples).toBeGreaterThan(50);
    expect(withSound).toBeGreaterThan(10);
  });

  it('calls the AD2 READY with no warnings, and the empty channels transmitter-off', () => {
    const { channels, last } = replay(report, 'axd');
    const connection: ConnectionStatus = { state: 'connected', since: last - 60_000, lastMessageAt: last };
    const judge = (n: number) => {
      const telemetry = channels.get(n)!;
      const ready = readiness({ assigned: true, connection, telemetry, now: last });
      const alerts = channelAlerts({ assigned: true, connection, telemetry, readiness: ready, now: last }, DEFAULT_ALERT_THRESHOLDS);
      return { ready, alerts: alerts.filter((a) => a.severity !== 'info').map((a) => a.code) };
    };
    expect(judge(1)).toEqual({ ready: { label: 'READY', source: 'receiver' }, alerts: [] });
    for (const n of [2, 3, 4]) {
      expect(txPresent(channels.get(n)!)).toBe(false);
      expect(judge(n).ready).toMatchObject({ label: 'CHECK_WITH_AUDIO', reason: 'Transmitter off or out of range' });
    }
  });
});
