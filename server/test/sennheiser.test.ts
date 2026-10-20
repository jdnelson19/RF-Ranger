import { afterEach, describe, expect, it } from 'vitest';
import { mentionsSsc, sscQuery } from '../src/adapters/sennheiser/discovery.js';
import { SENNHEISER_FAMILIES, familyForProduct, initialTelemetry } from '../src/adapters/sennheiser/families.js';
import { identifySennheiser } from '../src/adapters/sennheiser/identify.js';
import { SennheiserReceiver } from '../src/adapters/sennheiser/receiver.js';
import { errors, leaves, merge, subscribe, tree } from '../src/adapters/sennheiser/ssc.js';
import type { SennheiserFamilyId } from '../src/adapters/sennheiser/families.js';
import { normalizeConfig } from '../src/server/config.js';
import { LiveManager, parseTarget } from '../src/server/live.js';
import { Runtime } from '../src/server/runtime.js';
import { SennheiserSim } from '../src/sim/sennheiser-sim.js';

const cleanup: Array<() => Promise<void> | void> = [];
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

describe('SSC messages', () => {
  it('builds and merges address trees', () => {
    expect(tree(['rx1', 'skx', 'battery'])).toEqual({ rx1: { skx: { battery: null } } });
    expect(merge(tree(['rx1', 'name']), tree(['rx1', 'carrier']), tree(['mm']))).toEqual({ rx1: { name: null, carrier: null }, mm: null });
  });

  it('flattens replies to address/value pairs, arrays as values', () => {
    const reply = { rx1: { name: 'Lead', skx: { battery: ['70%', '5:12'] } }, mm: [[1, 2]], osc: { ping: null } };
    expect(leaves(reply)).toEqual([
      ['/rx1/name', 'Lead'],
      ['/rx1/skx/battery', ['70%', '5:12']],
      ['/mm', [[1, 2]]],
    ]);
  });

  it('reads error replies', () => {
    const reply = { osc: { error: [{ mates: { tx1: { battery: { gauge: [424, { desc: 'failed dependency' }] } } } }] } };
    expect(errors(reply)).toEqual([['/mates/tx1/battery/gauge', 424]]);
    expect(errors({ rx1: { name: 'x' } })).toEqual([]);
  });

  it('builds subscriptions with notification rate and lifetime', () => {
    expect(subscribe({ mm: null }, { intervalMs: 480, lifetimeS: 20 })).toEqual({
      osc: { state: { subscribe: [{ '#': { min: 480, max: 480, count: 100_000, lifetime: 20 }, mm: null }] } },
    });
  });
});

describe('Sennheiser families', () => {
  const at = 1_000;

  it('maps Digital 6000 meters from raw /mm units', () => {
    const f = SENNHEISER_FAMILIES.d6000;
    const t = initialTelemetry(f);
    f.apply('/rx1/skx/type', ['SK 6000', '470 MHz', '558 MHz'], () => t, at);
    // RF 145 → -55 dBm, 133 → -61 dBm; AF 195 → -30 dBFS; LQI 255 → 5.
    f.apply('/mm', [[145, 145, 133, 133, 1, 0, 255, 195, 0]], (n) => (n === 1 ? t : undefined), at);
    expect(t.rfDbm).toMatchObject({ state: 'ok', value: [-55, -61] });
    expect(t.antennas).toMatchObject({ state: 'ok', value: 'AX' });
    expect(t.linkQuality).toMatchObject({ state: 'ok', value: 5 });
    expect(t.audioRmsDbfs).toMatchObject({ state: 'ok', value: -30 });
    expect(t.audioPeakDbfs).toMatchObject({ state: 'ok', value: -30 });
    f.apply('/mm', [[145, 145, 133, 133, 1, 1, 255, 195, 1]], () => t, at);
    expect(t.audioPeakDbfs).toMatchObject({ value: 0 });
    expect(t.antennas).toMatchObject({ value: 'AB' });
  });

  it('maps Digital 6000 battery states and a missing transmitter', () => {
    const f = SENNHEISER_FAMILIES.d6000;
    const t = initialTelemetry(f);
    f.apply('/rx1/skx/type', ['SK 6000'], () => t, at);
    f.apply('/rx1/skx/battery', ['70%', '5:12'], () => t, at);
    expect(t.batteryBars).toMatchObject({ state: 'ok', value: 4 });
    expect(t.batteryRuntimeMin).toMatchObject({ state: 'ok', value: 312 });
    f.apply('/rx1/skx/battery', ['low', '-:--'], () => t, at);
    expect(t.batteryBars).toMatchObject({ value: 1 });
    expect(t.batteryRuntimeMin.state).toBe('absent');
    f.apply('/rx1/skx/type', [], () => t, at);
    expect(t.txModel.state).toBe('absent');
    expect(t.batteryBars.state).toBe('absent');
  });

  it('maps EW-DX meters, battery and warnings', () => {
    const f = SENNHEISER_FAMILIES.ewdx;
    const t = initialTelemetry(f);
    const ch = (n: number) => (n === 2 ? t : undefined);
    expect(f.apply('/m/rx2/rssi', -48.6, ch, at)).toBe(2);
    f.apply('/m/rx2/divi', 2, ch, at);
    f.apply('/m/rx2/rsqi', 81, ch, at);
    f.apply('/mates/tx2/battery/gauge', 60, ch, at);
    f.apply('/mates/tx2/battery/type', 'Primary Cell', ch, at);
    f.apply('/rx2/warnings', ['Aes256Error'], ch, at);
    expect(t.rfDbm).toMatchObject({ value: [-49] });
    expect(t.antennas).toMatchObject({ value: 'XB' });
    expect(t.linkQuality).toMatchObject({ value: 4 });
    expect(t.batteryPercent).toMatchObject({ value: 60 });
    expect(t.batteryType).toMatchObject({ value: 'AA' });
    expect(t.encryptionFault).toMatchObject({ value: true });
    expect(t.batteryBars.state).toBe('unsupported');
  });

  it('treats EW-DX error 424 as no transmitter', () => {
    const f = SENNHEISER_FAMILIES.ewdx;
    const t = initialTelemetry(f);
    f.apply('/mates/tx1/battery/gauge', 80, () => t, at);
    expect(f.applyError('/mates/tx1/battery/gauge', 424, () => t, at)).toBe(1);
    expect(t.batteryPercent.state).toBe('absent');
    expect(f.applyError('/rx1/name', 404, () => t, at)).toBeUndefined();
  });

  it.each([
    ['EM 6000', { family: 'd6000', channels: 2 }],
    ['EM6000-Dante', { family: 'd6000', channels: 2 }],
    ['EW-DX EM 2', { family: 'ewdx', channels: 2 }],
    ['EW-DX EM 4 Dante', { family: 'ewdx', channels: 4 }],
    ['EM 4', { family: 'ewdx', channels: 4 }],
  ])('recognises %s', (product, expected) => {
    expect(familyForProduct(product)).toEqual(expected);
  });

  it('explains products it does not support', () => {
    expect(familyForProduct('CHG 70N')).toMatchObject({ unsupported: expect.stringMatching(/not supported/) });
    expect(familyForProduct('SpeechLine')).toMatchObject({ unsupported: expect.stringMatching(/Unrecognised/) });
  });
});

describe('SSC discovery packets', () => {
  it('asks for PTR _ssc._udp.local', () => {
    const q = sscQuery();
    expect(q.readUInt16BE(4)).toBe(1); // one question
    expect(q.subarray(12).toString('latin1')).toContain('\x04_ssc\x04_udp\x05local\x00');
    expect(q.readUInt16BE(q.length - 4)).toBe(12); // PTR
  });

  it('only accepts responses that mention the service', () => {
    const response = Buffer.from(sscQuery());
    response[2] = 0x84; // response, authoritative
    expect(mentionsSsc(response)).toBe(true);
    expect(mentionsSsc(sscQuery())).toBe(false); // a query, not an answer
    const other = Buffer.from(response.toString('latin1').replace('_ssc', '_abc'), 'latin1');
    expect(mentionsSsc(other)).toBe(false);
  });
});

async function setup(family: SennheiserFamilyId, sim = new SennheiserSim({ family })) {
  const port = await sim.listen();
  const rx = new SennheiserReceiver({ id: 'rx', host: '127.0.0.1', port, family, channels: sim.channels.length, meterRateMs: 100 });
  cleanup.push(() => sim.close(), () => rx.stop());
  return { sim, rx, port };
}

describe.each<SennheiserFamilyId>(['ewdx', 'd6000'])('SennheiserReceiver against simulated %s', (family) => {
  it('connects, reads channel state and meters', async () => {
    const { sim, rx } = await setup(family);
    sim.update(1, { name: 'Lead Vox', rfDbm: -50, audioDbfs: -20 });
    rx.start();

    await until(() => rx.channels.get(1)!.telemetry.rfDbm.state === 'ok' && rx.channels.get(1)!.telemetry.name.state === 'ok');
    const t = rx.channels.get(1)!.telemetry;
    expect(rx.status.state).toBe('connected');
    expect(t.name).toMatchObject({ value: 'Lead Vox' });
    expect(t.frequencyKhz).toMatchObject({ value: 520_100 });
    expect(t.txModel).toMatchObject({ value: sim.channels[0]!.txModel });
    expect((t.rfDbm.state === 'ok' && t.rfDbm.value[0]) || 0).toBe(-50);
    expect(t.audioRmsDbfs).toMatchObject({ value: -20 });
    await until(() => rx.info.model !== undefined);
    expect(rx.info.model).toBe(sim.product);
    expect(rx.info.deviceId).toBe('SIM');
    expect(rx.channels.get(1)!.levels.bins(Date.now()).audio.some((v) => v !== null)).toBe(true);
  });

  it('follows changes through its subscription', async () => {
    const { sim, rx } = await setup(family);
    rx.start();
    await until(() => rx.channels.get(2)!.telemetry.txModel.state === 'ok');
    sim.update(2, { name: 'Pastor' });
    await until(() => rx.channels.get(2)!.telemetry.name.state === 'ok' && (rx.channels.get(2)!.telemetry.name as { value: string }).value === 'Pastor');
    sim.update(2, { txOn: false });
    await until(() => rx.channels.get(2)!.telemetry.txModel.state === 'absent');
    expect(rx.channels.get(2)!.telemetry.linkQuality.state).toBe('absent');
  });

  it('cancels its subscriptions when stopped', async () => {
    const { sim, rx } = await setup(family);
    rx.start();
    await until(() => sim.subscriptions === 2);
    await rx.stop();
    await until(() => sim.subscriptions === 0);
  });
});

describe('SennheiserReceiver connection', () => {
  it('reads an EW-DX transmitter again when it comes back on', async () => {
    const { sim, rx } = await setup('ewdx', new SennheiserSim({ family: 'ewdx', channels: [{ txOn: false }, {}] }));
    rx.start();
    await until(() => rx.status.state === 'connected' && rx.channels.get(1)!.telemetry.txModel.state === 'absent');
    sim.update(1, { txOn: true, batteryPercent: 55 });
    await until(() => rx.channels.get(1)!.telemetry.batteryPercent.state === 'ok');
    expect(rx.channels.get(1)!.telemetry.batteryPercent).toMatchObject({ value: 55 });
    expect(rx.channels.get(1)!.telemetry.txModel).toMatchObject({ value: 'SKM-S' });
  });

  it('re-subscribes when the device ends a subscription', async () => {
    const sim = new SennheiserSim({ family: 'ewdx' });
    const port = await sim.listen();
    // Lifetime is 60 s; the sim ends it early to stand in for an expiry.
    const rx = new SennheiserReceiver({ id: 'rx', host: '127.0.0.1', port, family: 'ewdx' });
    cleanup.push(() => sim.close(), () => rx.stop());
    rx.start();
    await until(() => sim.subscriptions === 2);
    const before = sim.received.length;
    (sim as unknown as { subs: Map<string, { expiresAt: number }> }).subs.forEach((s) => (s.expiresAt = 0));
    await until(() => sim.received.slice(before).some((m) => JSON.stringify(m).includes('subscribe')) && sim.subscriptions === 2, 3_000);
  });

  it('goes offline when the device stops answering', async () => {
    const sim = new SennheiserSim({ family: 'd6000' });
    const port = await sim.listen();
    const rx = new SennheiserReceiver({ id: 'rx', host: '127.0.0.1', port, family: 'd6000', silenceTimeoutMs: 600 });
    cleanup.push(() => rx.stop());
    rx.start();
    await until(() => rx.status.state === 'connected');
    await sim.close();
    await until(() => rx.status.state === 'connecting', 3_000);
  });
});

describe('identifySennheiser', () => {
  it('names the product and family', async () => {
    const sim = new SennheiserSim({ family: 'ewdx', product: 'EW-DX EM 2', deviceName: 'Stage Right' });
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    expect(await identifySennheiser('127.0.0.1', port)).toMatchObject({
      reachable: true, product: 'EW-DX EM 2', deviceName: 'Stage Right', family: 'ewdx', channels: 2,
    });
  });

  it('reports silence as unreachable', async () => {
    const sim = new SennheiserSim({ family: 'ewdx' });
    const port = await sim.listen();
    await sim.close();
    expect(await identifySennheiser('127.0.0.1', port, 300)).toMatchObject({ reachable: false });
  });
});

describe('live mode with Sennheiser devices', () => {
  it.each([
    ['ewdx@10.0.1.40/4', { host: '10.0.1.40', family: 'ewdx', channels: 4 }],
    ['d6000@10.0.1.41', { host: '10.0.1.41', family: 'd6000' }],
  ])('parses %s', (spec, expected) => {
    expect(parseTarget(spec)).toMatchObject(expected);
  });

  it('identifies and monitors a Digital 6000 given by address', async () => {
    const sim = new SennheiserSim({ family: 'd6000', deviceName: 'Rack B', channels: [{ name: 'Choir' }, { name: 'Pulpit' }] });
    const port = await sim.listen();
    const runtime = new Runtime(normalizeConfig({}), 'live');
    runtime.start();
    const live = new LiveManager(runtime, { discover: false, targets: [parseTarget(`d6000@127.0.0.1:${port}`)] });
    await live.start();
    cleanup.push(() => sim.close(), () => live.stop(), () => runtime.stop());

    await until(() => runtime.snapshot().slots.length === 2 && runtime.snapshot().receivers[0]?.status.state === 'connected');
    const snap = runtime.snapshot();
    expect(snap.receivers.map((r) => [r.info.id, r.info.manufacturer, r.info.model])).toEqual([['Rack B', 'sennheiser', 'EM 6000']]);
    expect(snap.discovered).toMatchObject([{ state: 'monitoring', kind: 'd6000', model: 'EM 6000' }]);
  });

  it('adds a device by hand and forgets it again, even one with no name', async () => {
    const sim = new SennheiserSim({ family: 'ewdx', product: 'EW-DX EM 2', deviceName: '' });
    const port = await sim.listen();
    const runtime = new Runtime(normalizeConfig({}), 'live');
    runtime.start();
    const live = new LiveManager(runtime, { discover: false, targets: [] });
    await live.start();
    cleanup.push(() => sim.close(), () => live.stop(), () => runtime.stop());

    const key = live.add(`ewdx@127.0.0.1:${port}`);
    expect(key).toBe(`127.0.0.1:${port}`);
    await until(() => runtime.snapshot().receivers[0]?.status.state === 'connected');
    expect(runtime.snapshot().receivers[0]!.info.id).toBe('EW-DX EM 2 .1');
    expect(live.forget(key)).toBe(true);
    expect(runtime.snapshot().receivers).toHaveLength(0);
    expect(() => live.add('not a host')).toThrow();
  });
});
