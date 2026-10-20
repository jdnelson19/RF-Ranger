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
