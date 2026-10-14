import { afterEach, describe, expect, it } from 'vitest';
import { ShureDiscovery, findDcid } from '../src/adapters/shure/discovery.js';
import { identifyShure, kindForModel } from '../src/adapters/shure/identify.js';
import { splitChannelName } from '../src/core/assignment.js';
import { normalizeConfig } from '../src/server/config.js';
import { LiveManager, parseTarget } from '../src/server/live.js';
import { Runtime } from '../src/server/runtime.js';
import { ChargerSim } from '../src/sim/charger-sim.js';
import { ShureSim } from '../src/sim/shure-sim.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('parseTarget', () => {
  it.each([
    ['10.0.1.20', { host: '10.0.1.20' }],
    ['axd@10.0.1.20', { host: '10.0.1.20', family: 'axd' }],
    ['ulxd@10.0.1.21/2', { host: '10.0.1.21', family: 'ulxd', channels: 2 }],
    ['127.0.0.1:22020', { host: '127.0.0.1', port: 22020 }],
    ['slxd@rx-3.local:2202/1', { host: 'rx-3.local', family: 'slxd', port: 2202, channels: 1 }],
  ])('%s', (spec, expected) => {
    expect(parseTarget(spec)).toMatchObject(expected);
  });

  it('rejects unknown families and junk', () => {
    expect(() => parseTarget('qlxd@10.0.0.1')).toThrow(/Unknown family/);
    expect(() => parseTarget('not a host')).toThrow();
  });
});

describe('splitChannelName (Micboard naming)', () => {
  it.each([
    ['H01 Fatai', { id: 'H01', name: 'Fatai' }],
    ['BP-3', { id: 'BP-3' }],
    ['Pastor Dan', { name: 'Pastor Dan' }],
    ['12 Lead_Vox', { id: '12', name: 'Lead Vox' }],
    ['', {}],
  ])('%j', (raw, expected) => {
    expect(splitChannelName(raw)).toEqual(expected);
  });
});

describe('kindForModel', () => {
  it.each([
    ['ULXD4Q', 'ulxd'],
    ['AD4Q-A', 'axd'],
    ['AD4D', 'axd'],
    ['SLXD4D', 'slxd'],
    ['SBC220', 'charger'],
    ['SBC240', 'charger'],
  ])('%s -> %s', (model, kind) => {
    expect(kindForModel(model).kind).toBe(kind);
  });

  it('explains models it does not support', () => {
    expect(kindForModel('QLXD4').unsupported).toMatch(/QLX-D/);
    expect(kindForModel('SBC850').unsupported).toMatch(/not supported/);
  });
});

describe('discovery packets', () => {
  it('extracts the device class ID', () => {
    expect(findDcid('(svcname-wunn=x),(cd:2Y8Q-A2AX-2WF6-J2E4),(other)')).toBe('2Y8Q-A2AX-2WF6-J2E4');
    expect(findDcid('no class here')).toBeUndefined();
  });

  it('reports each address once and counts repeats', () => {
    const d = new ShureDiscovery();
    const found: string[] = [];
    d.on('found', (s) => found.push(s.ip));
    d.handle('10.0.0.5', Buffer.from('a'), 1);
    d.handle('10.0.0.5', Buffer.from('b'), 2);
    d.handle('10.0.0.6', Buffer.from('c'), 3);
    expect(found).toEqual(['10.0.0.5', '10.0.0.6']);
    expect(d.seen.get('10.0.0.5')).toMatchObject({ packets: 2, firstSeen: 1, lastSeen: 2 });
  });
});

describe('identifyShure', () => {
  it('identifies an Axient receiver and counts its channels', async () => {
    const sim = new ShureSim({ family: 'axd', deviceId: 'RF 1-4' });
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    expect(await identifyShure('127.0.0.1', port)).toMatchObject({ reachable: true, model: 'AD4Q-A', kind: 'axd', channels: 4, deviceId: 'RF 1-4' });
  });

  it('falls back for ULX-D firmware that does not answer MODEL', async () => {
    const sim = new ShureSim({ family: 'ulxd', answersModel: false, channels: [{}, {}] });
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    expect(await identifyShure('127.0.0.1', port)).toMatchObject({ reachable: true, kind: 'ulxd', channels: 2 });
  });

  it('identifies a networked charger and its bays', async () => {
    const sim = new ChargerSim([{}, {}, {}, {}]);
    const port = await sim.listen();
    cleanup.push(() => sim.close());
    expect(await identifyShure('127.0.0.1', port)).toMatchObject({ kind: 'charger', model: 'SBC220', channels: 4 });
  });

  it('reports an address with nothing listening', async () => {
    const id = await identifyShure('127.0.0.1', 1, 1_000);
    expect(id.reachable).toBe(false);
  });
});

describe('LiveManager', () => {
  it('monitors devices given by address, naming slots from receiver channel names', async () => {
    const rxSim = new ShureSim({
      family: 'axd',
      deviceId: 'Stage Left',
      channels: [{ name: 'H1 Maya' }, { name: 'H2 Jordan' }, { name: 'Spare' }, { name: '' }],
    });
    const chgSim = new ChargerSim([{}, {}]);
    const [rxPort, chgPort] = await Promise.all([rxSim.listen(), chgSim.listen()]);

    const runtime = new Runtime(normalizeConfig({}), 'live');
    runtime.start();
    const live = new LiveManager(runtime, {
      discover: false,
      targets: [parseTarget(`127.0.0.1:${rxPort}`), parseTarget(`127.0.0.1:${chgPort}`, true)],
    });
    await live.start();
    cleanup.push(() => rxSim.close(), () => chgSim.close(), () => live.stop(), () => runtime.stop());

    await until(() => runtime.snapshot().slots.filter((s) => s.assignment).length === 3);
    const snap = runtime.snapshot();

    expect(snap.mode).toBe('live');
    expect(snap.receivers.map((r) => r.info.id)).toEqual(['Stage Left']);
    expect(snap.slots.map((s) => [s.label, s.assignment?.artist ?? null, s.group])).toEqual([
      ['H1', 'Maya', 'Stage Left'],
      ['H2', 'Jordan', 'Stage Left'],
      ['3', 'Spare', 'Stage Left'],
      ['4', null, 'Stage Left'],
    ]);
    expect(snap.chargers).toHaveLength(1);
    expect(snap.discovered.map((d) => d.state)).toEqual(['monitoring', 'monitoring']);
  });

  it('keeps an unreachable named device listed and retries it', async () => {
    const runtime = new Runtime(normalizeConfig({}), 'live');
    const live = new LiveManager(runtime, { discover: false, targets: [parseTarget('127.0.0.1:1')] });
    await live.start();
    cleanup.push(() => live.stop(), () => runtime.stop());
    await until(() => runtime.snapshot().discovered[0]?.state === 'unreachable');
    expect(runtime.snapshot().receivers).toHaveLength(0);
  });
});
