import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/server/config.js';
import { KnownDevices } from '../src/server/known-devices.js';
import { LiveManager } from '../src/server/live.js';
import { Runtime } from '../src/server/runtime.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'rf-ranger-known-')), 'known-devices.json');

describe('remembered devices', () => {
  it('saves receivers, chargers and channel names, and forgets them', () => {
    const path = tmp();
    const known = new KnownDevices(path);
    known.rememberReceiver({ id: 'AD4Q-A', host: '10.0.0.5', family: 'axd', channels: 4, model: 'AD4Q' }, 1000);
    known.rememberCharger({ id: 'SBC-1', host: '10.0.0.9' }, 1000);
    known.setNames('AD4Q-A', { 1: 'RF1 Sam', 2: 'RF2' });

    const again = new KnownDevices(path);
    expect(again.list().receivers).toEqual([{ id: 'AD4Q-A', host: '10.0.0.5', family: 'axd', channels: 4, model: 'AD4Q', names: { 1: 'RF1 Sam', 2: 'RF2' }, lastSeen: 1000 }]);
    expect(again.name('AD4Q-A', 1)).toBe('RF1 Sam');
    expect(again.forget('10.0.0.5')).toBe(true);
    expect(new KnownDevices(path).list()).toMatchObject({ receivers: [], chargers: [{ id: 'SBC-1' }] });
  });

  it('puts a switched-off receiver\'s channels on screen at startup, with their last names, until forgotten', async () => {
    const known = new KnownDevices();
    known.rememberReceiver({ id: 'AD4Q-A', host: '10.0.0.5', family: 'axd', channels: 2 });
    known.setNames('AD4Q-A', { 1: 'RF1 Sam', 2: 'RF2' });
    const runtime = new Runtime(normalizeConfig({}), 'live'); // not started: nothing is contacted
    runtime.rememberedName = (id, ch) => known.name(id, ch);
    const live = new LiveManager(runtime, { discover: false, targets: [], known });
    await live.start();

    const snap = runtime.snapshot();
    expect(snap.slots.map((s) => [s.key, s.label, s.assignment?.artist])).toEqual([['AD4Q-A/1', 'RF1', 'Sam'], ['AD4Q-A/2', 'RF2', undefined]]);
    expect(snap.discovered).toMatchObject([{ host: '10.0.0.5', source: 'remembered', state: 'monitoring' }]);

    expect(live.forget('10.0.0.5')).toBe(true);
    expect(runtime.snapshot().slots).toEqual([]);
    expect(known.list().receivers).toEqual([]);
    live.stop();
  });
});

describe('one device per address', () => {
  it('treats standard ports as the same device, custom ports as different', async () => {
    const { deviceKey } = await import('../src/server/known-devices.js');
    expect(deviceKey('10.0.0.5')).toBe('10.0.0.5');
    expect(deviceKey('10.0.0.5', 2202)).toBe('10.0.0.5');
    expect(deviceKey('10.0.0.5', 2201)).toBe('10.0.0.5');
    expect(deviceKey('10.0.0.5', 45)).toBe('10.0.0.5');
    expect(deviceKey('127.0.0.1', 50123)).toBe('127.0.0.1:50123');
  });

  it('merges a device saved twice by an earlier version, keeping its original name', async () => {
    const { writeFileSync, readFileSync } = await import('node:fs');
    const path = tmp();
    writeFileSync(path, JSON.stringify({
      version: 1,
      receivers: [
        { id: 'Aud 2', host: '10.0.0.7', port: 2201, family: 'psm1000', names: { 1: 'IEM Vox', 2: 'IEM Keys' }, lastSeen: 100 },
        { id: 'Aud 2 (2)', host: '10.0.0.7', port: 2202, family: 'psm1000', model: 'P10T', names: { 2: 'IEM Keys 2' }, lastSeen: 200 },
        { id: 'AD4Q-A', host: '10.0.0.5', family: 'axd', names: {}, lastSeen: 50 },
      ],
      chargers: [],
    }));
    const known = new KnownDevices(path);
    expect(known.list().receivers).toEqual([
      { id: 'Aud 2', host: '10.0.0.7', port: 2202, family: 'psm1000', model: 'P10T', names: { 1: 'IEM Vox', 2: 'IEM Keys' }, lastSeen: 200 },
      { id: 'AD4Q-A', host: '10.0.0.5', family: 'axd', names: {}, lastSeen: 50 },
    ]);
    // The cleaned-up list is saved straight away.
    expect(JSON.parse(readFileSync(path, 'utf8')).receivers).toHaveLength(2);
  });

  it('updates the remembered device when it is found again on another standard port', () => {
    const known = new KnownDevices();
    known.rememberReceiver({ id: 'Aud 2', host: '10.0.0.7', family: 'psm1000' }, 1);
    known.setNames('Aud 2', { 1: 'IEM Vox' });
    known.rememberReceiver({ id: 'Aud 2', host: '10.0.0.7', port: 2202, family: 'psm1000' }, 2);
    expect(known.list().receivers).toEqual([{ id: 'Aud 2', host: '10.0.0.7', port: 2202, family: 'psm1000', names: { 1: 'IEM Vox' }, lastSeen: 2 }]);
  });

  it('does not add a remembered receiver again when it is found by its address', async () => {
    const known = new KnownDevices();
    known.rememberReceiver({ id: 'Aud 2', host: '10.0.0.7', port: 2202, family: 'psm1000', channels: 2 });
    const runtime = new Runtime(normalizeConfig({}), 'live'); // not started: nothing is contacted
    const live = new LiveManager(runtime, { discover: false, targets: [], known });
    await live.start();
    expect(live.add('10.0.0.7')).toBe('10.0.0.7');
    expect(live.add('psm1000@10.0.0.7')).toBe('10.0.0.7');
    await new Promise((r) => setTimeout(r, 50));
    const snap = runtime.snapshot();
    expect(snap.receivers.map((r) => r.info.id)).toEqual(['Aud 2']);
    expect(snap.slots).toHaveLength(2);
    expect(snap.discovered).toMatchObject([{ host: '10.0.0.7', source: 'remembered' }]);
    live.stop();
  });
});
