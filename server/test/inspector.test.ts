import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/server/config.js';
import { Inspector, isLocalRequest, normalizeGet, redact } from '../src/server/inspector.js';
import { Runtime } from '../src/server/runtime.js';
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

describe('normalizeGet', () => {
  it('accepts GET commands in either form', () => {
    expect(normalizeGet('GET 1 ALL')).toBe('< GET 1 ALL >');
    expect(normalizeGet('< get  1   batt_bars >')).toBe('< GET 1 BATT_BARS >');
  });

  it.each(['SET 1 AUDIO_MUTE ON', '< SET 1 FREQUENCY 470000 >', 'GET 1 ALL >< SET 1 AUDIO_MUTE ON', 'GET 1 CHAN_NAME {x}', 'FLASH ON', ''])(
    'refuses %j',
    (cmd) => {
      expect(() => normalizeGet(cmd)).toThrow();
    },
  );
});

describe('redact', () => {
  it('removes names, device IDs and addresses', () => {
    expect(redact('< REP 1 CHAN_NAME {Lead Vox  } >')).toBe('< REP 1 CHAN_NAME {redacted} >');
    expect(redact('< REP DEVICE_ID {Stage Left} >')).toBe('< REP DEVICE_ID {redacted} >');
    expect(redact('< REP 1 SLOT_TX_DEVICE_ID 3 {Pastor} >')).toBe('< REP 1 SLOT_TX_DEVICE_ID 3 {redacted} >');
    expect(redact('Connection failed: connect ECONNREFUSED 10.1.2.3:2202')).toBe('Connection failed: connect ECONNREFUSED x.x.x.x:2202');
  });

  it('keeps protocol data', () => {
    expect(redact('< REP 1 BATT_BARS 004 >')).toBe('< REP 1 BATT_BARS 004 >');
    expect(redact('< SAMPLE 1 ALL 005 031 102 090 BB 31 086 31 065 >')).toBe('< SAMPLE 1 ALL 005 031 102 090 BB 31 086 31 065 >');
  });
});

describe('isLocalRequest', () => {
  const req = (remote: string, host: string, origin?: string) =>
    ({ socket: { remoteAddress: remote }, headers: { host, ...(origin ? { origin } : {}) } }) as unknown as http.IncomingMessage;

  it('allows the machine running RF Ranger', () => {
    expect(isLocalRequest(req('127.0.0.1', 'localhost:8058'))).toBe(true);
    expect(isLocalRequest(req('::1', '[::1]:8058', 'http://[::1]:8058'))).toBe(true);
    expect(isLocalRequest(req('::ffff:127.0.0.1', '127.0.0.1:8058', 'http://localhost:5173'))).toBe(true);
  });

  it('refuses other machines on the network', () => {
    expect(isLocalRequest(req('192.168.1.40', '192.168.1.10:8058'))).toBe(false);
  });

  it('refuses DNS-rebinding and cross-site requests', () => {
    expect(isLocalRequest(req('127.0.0.1', 'evil.example:8058'))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', 'localhost:8058', 'https://evil.example'))).toBe(false);
  });
});

describe('Inspector sessions', () => {
  async function setup() {
    const sim = new ShureSim({ family: 'axd', deviceId: 'Stage Left', channels: [{ name: 'Lead Vox' }, {}] });
    const port = await sim.listen();
    const runtime = new Runtime(normalizeConfig({}), 'live');
    const inspector = new Inspector(runtime);
    cleanup.push(() => sim.close(), () => inspector.closeAll());
    return { sim, port, inspector, runtime };
  }

  it('watches an unmonitored device, queries it, and collects keys', async () => {
    const { port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port);
    await until(() => inspector.view(id).status === 'connected');
    inspector.send(id, 'GET 0 ALL');
    await until(() => inspector.view(id).keys.some((k) => k.key === 'TX_BATT_BARS'));

    const v = inspector.view(id);
    expect(v.frames.some((f) => f.dir === 'out' && f.frame === '< GET 0 ALL >')).toBe(true);
    expect(v.keys.find((k) => k.key === 'CHAN_NAME' && k.channel === 1)?.value).toBe('Lead Vox');
    await until(() => inspector.view(id).identity?.model === 'AD4Q-A');
  });

  it('returns only frames newer than the last one seen', async () => {
    const { port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port);
    await until(() => inspector.view(id).lastSeq > 2);
    const last = inspector.view(id).lastSeq;
    inspector.send(id, 'GET 1 TX_MODEL');
    await until(() => inspector.view(id, last).frames.length >= 2);
    expect(inspector.view(id, last).frames.every((f) => f.seq > last)).toBe(true);
  });

  it('meters for a limited time and switches metering off on close', async () => {
    const { port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port);
    await until(() => inspector.view(id).status === 'connected' && !!inspector.view(id).identity);
    inspector.meter(id, 5);
    await until(() => inspector.view(id).keys.some((k) => k.key === 'SAMPLE ALL'));
    const out = () => inspector.view(id).frames.filter((f) => f.dir === 'out').map((f) => f.frame);
    expect(out()).toContain('< SET 1 METER_RATE 01000 >');
    inspector['stopMetering'](inspector['get'](id));
    expect(out()).toContain('< SET 1 METER_RATE 00000 >');
  });

  it('exports an anonymized report by default', async () => {
    const { port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port);
    inspector.setTags(id, { kind: 'axd', notes: 'AD2 with SB920' });
    await until(() => inspector.view(id).keys.some((k) => k.key === 'DEVICE_ID'));

    const report = inspector.report(id, true);
    const text = JSON.stringify(report);
    expect(report).toMatchObject({ kind: 'rf-ranger-device-report', anonymized: true, device: { host: 'redacted', userTags: { notes: 'AD2 with SB920' } } });
    expect(text).not.toContain('Stage Left');
    expect(text).not.toContain('127.0.0.1');
    expect(inspector.report(id, false).device.host).toBe('127.0.0.1');
  });

  it('reuses the connection of a device RF Ranger already monitors', async () => {
    const { port, inspector, runtime } = await setup();
    runtime.addReceiver({ id: 'RX', family: 'axd', host: '127.0.0.1', port, channels: 2 });
    runtime.start();
    cleanup.push(() => runtime.stop());
    const { id } = inspector.open('127.0.0.1', port);
    expect(inspector.view(id).monitoredBy).toBe('RX');
    await until(() => inspector.view(id).keys.some((k) => k.key === 'SAMPLE ALL'));
    expect(() => inspector.meter(id, 10)).toThrow(/already metered/);
  });
});
