import { afterEach, describe, expect, it } from 'vitest';
import { SHURE_FAMILIES, initialTelemetry } from '../src/adapters/shure/families.js';
import { identifyShure, identifyShureOnPorts, kindForModel } from '../src/adapters/shure/identify.js';
import { parseMessage } from '../src/adapters/shure/protocol.js';
import { ShureReceiver } from '../src/adapters/shure/receiver.js';
import { channelAlerts } from '../src/core/alerts.js';
import { emptyBay, type ChannelTelemetry, type ConnectionStatus } from '../src/core/model.js';
import { ok } from '../src/core/reading.js';
import { DEFAULT_THRESHOLDS, readiness, type ReadinessInput } from '../src/core/readiness.js';
import { DEFAULT_ALERT_THRESHOLDS } from '../src/server/config.js';
import { ShureSim } from '../src/sim/shure-sim.js';

const NOW = 1_000_000;
const connected: ConnectionStatus = { state: 'connected', since: NOW - 60_000, lastMessageAt: NOW - 200 };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function until(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function feed(frames: string[]): ChannelTelemetry {
  const family = SHURE_FAMILIES.psm1000;
  const t = initialTelemetry(family);
  for (const frame of frames) {
    const m = parseMessage(frame);
    if (m.kind === 'rep') family.reports[m.key]?.(t, m.args, NOW);
  }
  return t;
}

function onAir(patch: Partial<ChannelTelemetry> = {}): ChannelTelemetry {
  return { ...initialTelemetry(SHURE_FAMILIES.psm1000), rfOutputMw: ok(50, NOW), rfMuted: ok(false, NOW), ...patch };
}

function check(patch: Partial<ChannelTelemetry> = {}, extra: Partial<ReadinessInput> = {}, th = DEFAULT_THRESHOLDS) {
  return readiness({ assigned: true, role: 'iem', connection: connected, telemetry: onAir(patch), now: NOW, ...extra }, th);
}

describe('PSM 1000 reports', () => {
  it('reads RF output, mute and audio mode', () => {
    const t = feed(['< REP 1 RF_TX_LVL 100 >', '< REP 1 RF_MUTE 0 >', '< REP 1 AUDIO_TX_MODE 3 >', '< REP 1 FREQUENCY 518125 >', '< REP 1 GROUP_CHAN 01,04 >']);
    expect(t.rfOutputMw).toEqual({ state: 'ok', value: 100, at: NOW });
    expect(t.rfMuted).toEqual({ state: 'ok', value: false, at: NOW });
    expect(t.audioMode).toEqual({ state: 'ok', value: 'Stereo', at: NOW });
    expect(t.frequencyKhz).toEqual({ state: 'ok', value: 518_125, at: NOW });
    expect(t.groupChannel).toMatchObject({ state: 'ok', value: '01,04' });
  });

  it('accepts word forms until the encoding is confirmed on hardware', () => {
    expect(feed(['< REP 1 RF_MUTE ON >']).rfMuted).toMatchObject({ state: 'ok', value: true });
    expect(feed(['< REP 1 RF_TX_LVL OFF >']).rfOutputMw).toMatchObject({ state: 'ok', value: 0 });
    expect(feed(['< REP 1 RF_TX_LVL 000050 >']).rfOutputMw).toMatchObject({ state: 'ok', value: 50 });
    expect(feed(['< REP 1 AUDIO_TX_MODE MIXMODE >']).audioMode).toMatchObject({ state: 'ok', value: 'MIXMODE' });
  });

  it('marks every bodypack metric unsupported', () => {
    const t = initialTelemetry(SHURE_FAMILIES.psm1000);
    for (const key of ['batteryBars', 'batteryPercent', 'txModel', 'rfDbm', 'audioRmsDbfs'] as const) {
      expect(t[key].state).toBe('unsupported');
    }
  });

  it('leaves IEM metrics unsupported on mic families', () => {
    const t = initialTelemetry(SHURE_FAMILIES.axd);
    expect(t.rfOutputMw.state).toBe('unsupported');
    expect(t.rfMuted.state).toBe('unsupported');
  });
});

describe('IEM readiness', () => {
  it('stops at STANDBY by default, since the pack is not monitored', () => {
    expect(check()).toMatchObject({ label: 'STANDBY', reason: 'IEM on air; pack battery not monitored' });
  });

  it('is READY on a healthy transmitter when configured to trust it', () => {
    expect(check({}, {}, { ...DEFAULT_THRESHOLDS, iemReadyWithoutCharger: true })).toMatchObject({ label: 'READY' });
  });

  it('is NOT READY when RF is muted or off', () => {
    expect(check({ rfMuted: ok(true, NOW) })).toMatchObject({ label: 'NOT_READY', reason: 'IEM RF muted' });
    expect(check({ rfOutputMw: ok(0, NOW) })).toMatchObject({ label: 'NOT_READY', reason: 'IEM RF off' });
  });

  it('never trusts a transmitter state it has not heard', () => {
    expect(check({ rfMuted: initialTelemetry(SHURE_FAMILIES.psm1000).rfMuted })).toMatchObject({ label: 'STANDBY', reason: 'IEM transmitter state unknown' });
    expect(check({ rfMuted: ok(false, NOW - 10 * 60_000) })).toMatchObject({ label: 'STANDBY' });
  });

  it('says which device is offline', () => {
    const down: ConnectionStatus = { state: 'disconnected', since: NOW };
    expect(check({}, { connection: down })).toMatchObject({ label: 'NOT_READY', reason: 'IEM transmitter offline' });
  });

  it('takes pack readiness from its charger bay', () => {
    const bay = { ...emptyBay(), batteryPresent: ok(true, NOW), chargePercent: ok(100, NOW), error: ok(null, NOW) };
    expect(check({}, { storage: { connection: connected, bay } })).toMatchObject({ label: 'STANDBY', status: 'On charger', source: 'charger', chargePercent: 100 });
    const empty = { ...bay, batteryPresent: ok(false, NOW) };
    expect(check({}, { storage: { connection: connected, bay: empty } })).toMatchObject({ label: 'STANDBY', reason: 'IEM pack not on its charger' });
  });

  it('puts a muted transmitter ahead of a charged pack', () => {
    const bay = { ...emptyBay(), batteryPresent: ok(true, NOW), chargePercent: ok(100, NOW), error: ok(null, NOW) };
    expect(check({ rfMuted: ok(true, NOW) }, { storage: { connection: connected, bay } })).toMatchObject({ label: 'NOT_READY' });
  });
});

describe('IEM alerts', () => {
  const alerts = (patch: Partial<ChannelTelemetry> = {}, assigned = true) => {
    const telemetry = onAir(patch);
    const ready = readiness({ assigned, role: 'iem', connection: connected, telemetry, now: NOW });
    return channelAlerts({ assigned, role: 'iem', connection: connected, telemetry, readiness: ready, now: NOW }, DEFAULT_ALERT_THRESHOLDS);
  };

  it('raises RF mute as critical for an assigned channel', () => {
    expect(alerts({ rfMuted: ok(true, NOW) })[0]).toMatchObject({ code: 'iem-rf-muted', severity: 'critical' });
  });

  it('only notes RF mute on a spare channel', () => {
    expect(alerts({ rfMuted: ok(true, NOW) }, false)).toEqual([{ code: 'iem-rf-muted', severity: 'info', message: 'IEM RF muted' }]);
  });

  it('never raises mic battery or transmitter-off alerts', () => {
    const codes = alerts().map((a) => a.code);
    expect(codes).toEqual(['iem-pack-unmonitored']);
  });
});

describe('PSM 1000 identification', () => {
  it('maps P10T models and declines other IEM transmitters', () => {
    expect(kindForModel('P10T')).toEqual({ kind: 'psm1000' });
    expect(kindForModel('ADTQ')).toMatchObject({ unsupported: expect.stringContaining('Axient Digital PSM') });
  });

  it('identifies a P10T that answers MODEL', async () => {
    const sim = new ShureSim({ family: 'psm1000', deviceId: 'IEM RACK' });
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    expect(await identifyShure('127.0.0.1', port)).toMatchObject({ kind: 'psm1000', model: 'P10T', deviceId: 'IEM RACK' });
  });

  it('falls back when the P10T does not answer MODEL', async () => {
    const sim = new ShureSim({ family: 'psm1000', answersModel: false });
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    expect(await identifyShure('127.0.0.1', port)).toMatchObject({ reachable: true, kind: 'psm1000', channels: 2 });
  });
});

describe('ShureReceiver against a simulated P10T', () => {
  it('reads each channel key by key and follows changes', async () => {
    const sim = new ShureSim({ family: 'psm1000', fragment: true, deviceId: 'IEM RACK' });
    const port = await sim.listen();
    const tx = new ShureReceiver({ id: 'iem', host: '127.0.0.1', port, family: 'psm1000', meterRateMs: 100 });
    cleanup.push(() => sim.close().catch(() => {}), () => tx.stop());
    sim.channels[1]!.name = 'Drums';
    tx.start();

    await until(() => tx.channels.get(2)!.telemetry.audioMode.state === 'ok');
    const t = tx.channels.get(2)!.telemetry;
    expect(tx.info.role).toBe('iem');
    expect(t.name).toMatchObject({ state: 'ok', value: 'Drums' });
    expect(t.rfOutputMw).toMatchObject({ state: 'ok', value: 50 });
    expect(t.rfMuted).toMatchObject({ state: 'ok', value: false });
    await until(() => tx.info.deviceId !== undefined);
    expect(tx.info.deviceId).toBe('IEM RACK');

    sim.update(2, { rfMuted: true });
    await until(() => tx.channels.get(2)!.telemetry.rfMuted.state === 'ok' && (tx.channels.get(2)!.telemetry.rfMuted as { value: boolean }).value);
  });

  it('stays connected without SAMPLE traffic', async () => {
    const sim = new ShureSim({ family: 'psm1000' });
    const port = await sim.listen();
    const tx = new ShureReceiver({ id: 'iem', host: '127.0.0.1', port, family: 'psm1000', silenceTimeoutMs: 3_000 });
    cleanup.push(() => sim.close().catch(() => {}), () => tx.stop());
    tx.start();
    await until(() => tx.status.state === 'connected');
    const since = tx.status.since;
    await new Promise((r) => setTimeout(r, 3_800));
    expect(tx.status).toMatchObject({ state: 'connected', since });
  });
});

describe('PSM 1000 control port', () => {
  async function closedPort(): Promise<number> {
    const s = (await import('node:net')).createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  }

  it('uses 2201 for the PSM 1000 and 2202 for everything else', () => {
    expect(SHURE_FAMILIES.psm1000.defaultPort).toBe(2201);
    for (const id of ['ulxd', 'axd', 'slxd'] as const) expect(SHURE_FAMILIES[id].defaultPort).toBe(2202);
  });

  it('finds a P10T on the second port tried, and says which port answered', async () => {
    const sim = new ShureSim({ family: 'psm1000', deviceId: 'IEM RACK' });
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    const nothing = await closedPort();
    expect(await identifyShureOnPorts('127.0.0.1', [nothing, port])).toMatchObject({ reachable: true, port, kind: 'psm1000', deviceId: 'IEM RACK' });
  });

  it('reports unreachable only after every port fails', async () => {
    const [a, b] = [await closedPort(), await closedPort()];
    expect(await identifyShureOnPorts('127.0.0.1', [a, b], 800)).toMatchObject({ reachable: false });
  });
});
