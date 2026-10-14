/**
 * Replays captures from real hardware (Device Inspector reports, anonymized)
 * through the same parsing the live receiver uses, at their original
 * timestamps. These pin down behaviour that simulators can only guess at.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUDIO_TRIM_DB, SHURE_FAMILIES, initialTelemetry, type ShureFamilyId } from '../src/adapters/shure/families.js';
import { parseMessage } from '../src/adapters/shure/protocol.js';
import { channelAlerts } from '../src/core/alerts.js';
import type { ChannelTelemetry, ConnectionStatus } from '../src/core/model.js';
import { absent } from '../src/core/reading.js';
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
  /** While on air the AD RMS meter bottoms out at raw 033 (-87 dBFS before the trim); peak keeps falling below it in silence. */
  const RMS_FLOOR_DBFS = 33 - 120 + AUDIO_TRIM_DB;

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

/** Readiness and non-info alerts for a channel, as the server would compute them at `now`. */
function assess(telemetry: ChannelTelemetry, now: number) {
  const connection: ConnectionStatus = { state: 'connected', since: now - 60_000, lastMessageAt: now };
  const ready = readiness({ assigned: true, connection, telemetry, now });
  const alerts = channelAlerts({ assigned: true, connection, telemetry, readiness: ready, now }, DEFAULT_ALERT_THRESHOLDS);
  return { ready, alerts: alerts.map((a) => a.code) };
}

describe('AD4Q-A with an AD1 bodypack', () => {
  const { channels, last } = replay(load('ad4q-ad1.json'), 'axd');

  it('reads the AD1 and a part-used battery, with a real runtime', () => {
    const t = channels.get(2)!;
    expect(t.txModel).toMatchObject({ state: 'ok', value: 'AD1' });
    expect(t.batteryBars).toMatchObject({ state: 'ok', value: 5 });
    expect(t.batteryPercent).toMatchObject({ state: 'ok', value: 81 });
    expect(t.batteryRuntimeMin).toMatchObject({ state: 'ok', value: 323 });
    expect(t.batteryHealthPercent).toMatchObject({ state: 'ok', value: 85 });
    expect(t.batteryCycles).toMatchObject({ state: 'ok', value: 181 });
    expect(t.batteryTempC).toMatchObject({ state: 'ok', value: 26 });
    expect(t.txTalkSwitch).toMatchObject({ state: 'ok', value: false });
  });

  it('is READY, and the other channels are transmitter-off', () => {
    expect(assess(channels.get(2)!, last)).toEqual({ ready: { label: 'READY', source: 'receiver' }, alerts: [] });
    for (const n of [1, 3, 4]) expect(txPresent(channels.get(n)!)).toBe(false);
  });
});

describe('AD4Q-A with an ADX2 talk switch', () => {
  const report = load('ad4q-adx2-talk.json');

  it('follows every press and release, and flags TALK only while held', () => {
    const seen: Array<{ held: boolean; talkAlert: boolean; ready: unknown; readyWithoutTalk: unknown }> = [];
    replay(report, 'axd', (t, frame, ch) => {
      if (!/^< REP 2 TX_TALK_SWITCH (ON|OFF) >$/.test(frame)) return;
      const c = ch.get(2)!;
      const { ready, alerts } = assess(c, t);
      seen.push({
        held: c.txTalkSwitch.state === 'ok' && c.txTalkSwitch.value,
        talkAlert: alerts.includes('tx-talk'),
        ready,
        readyWithoutTalk: assess({ ...c, txTalkSwitch: absent(t) }, t).ready,
      });
    });
    expect(seen.map((s) => s.held)).toEqual([true, false, true, false, true, false]);
    expect(seen.every((s) => s.talkAlert === s.held)).toBe(true);
    // Talk is an intentional action, not a fault: it never changes readiness.
    // (The capture joined an open connection, so the battery is only learned at
    // the 30 s poll; the first press happens before that.)
    for (const s of seen) expect(s.ready).toEqual(s.readyWithoutTalk);
  });

  it('reads the ADX2 and the AD2 beside it', () => {
    const { channels, last } = replay(report, 'axd');
    expect(channels.get(2)!.txModel).toMatchObject({ state: 'ok', value: 'ADX2' });
    expect(channels.get(1)!.txModel).toMatchObject({ state: 'ok', value: 'AD2' });
    expect(channels.get(2)!.batteryRuntimeMin).toMatchObject({ state: 'ok', value: 565 });
    for (const n of [1, 2]) expect(assess(channels.get(n)!, last).ready.label).toBe('READY');
  });
});

describe('ULXD4 with a ULXD1 switched off and on again', () => {
  const report = load('ulxd4-ulxd1-off-on.json');
  const frameAt = (frame: string, after = 0) => report.frames.find((f) => f.frame === frame && f.t > after)!.t;
  const offDone = frameAt('< REP 1 TX_TYPE UNKN >');
  const backOn = frameAt('< REP 1 TX_TYPE ULXD1 >', offDone);

  it('goes transmitter-off with the off burst and back on with TX_TYPE', () => {
    const states: Array<{ t: number; on: boolean; reason?: string }> = [];
    replay(report, 'ulxd', (t, _f, ch) => {
      const c = ch.get(1);
      if (c && c.txModel.state !== 'unknown') states.push({ t, on: txPresent(c), reason: assess(c, t).ready.reason });
    });
    const before = states.filter((s) => s.t < offDone - 100);
    const off = states.filter((s) => s.t >= offDone && s.t < backOn);
    const after = states.filter((s) => s.t >= backOn);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((s) => s.on)).toBe(true);
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((s) => !s.on && s.reason === 'Transmitter off or out of range')).toBe(true);
    expect(after.every((s) => s.on)).toBe(true);
  });

  it('keeps the ULXD1 mute status and reads its battery after power-on', () => {
    const { channels, last } = replay(report, 'ulxd');
    const t = channels.get(1)!;
    expect(t.txModel).toMatchObject({ state: 'ok', value: 'ULXD1' });
    expect(t.txMuted).toMatchObject({ state: 'ok', value: false });
    expect(t.batteryBars).toMatchObject({ state: 'ok', value: 5 });
    expect(t.batteryPercent).toMatchObject({ state: 'ok', value: 97 });
    expect(t.batteryRuntimeMin).toMatchObject({ state: 'ok', value: 373 });
    expect(t.batteryHealthPercent).toMatchObject({ state: 'ok', value: 81 });
    expect(t.batteryCycles).toMatchObject({ state: 'ok', value: 650 });
    expect(t.batteryTempC).toMatchObject({ state: 'ok', value: 21 }); // raw " 61": two digits, padded with a space
    expect(t.batteryType).toMatchObject({ state: 'ok', value: 'LION' });
    expect(assess(t, last).ready).toEqual({ label: 'READY', source: 'receiver' });
  });
});
