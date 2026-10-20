import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSscRead, redactSsc } from '../src/server/inspector-ssc.js';
import { Inspector } from '../src/server/inspector.js';
import { normalizeConfig } from '../src/server/config.js';
import { Runtime } from '../src/server/runtime.js';
import { SennheiserSim } from '../src/sim/sennheiser-sim.js';

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

describe('normalizeSscRead', () => {
  it('turns addresses into a read', () => {
    expect(normalizeSscRead('/rx1/name /rx1/skx/battery /mm')).toEqual({ rx1: { name: null, skx: { battery: null } }, mm: null });
  });

  it('accepts JSON reads and schema queries', () => {
    expect(normalizeSscRead('{"rx1":{"carrier":null}}')).toEqual({ rx1: { carrier: null } });
    expect(normalizeSscRead('{"osc":{"schema":null}}')).toEqual({ osc: { schema: null } });
    expect(normalizeSscRead('{"osc":{"limits":[{"rx1":{"carrier":null}}]}}')).toBeTruthy();
  });

  it('refuses anything that would change the device', () => {
    expect(() => normalizeSscRead('{"rx1":{"name":"HACKED"}}')).toThrow(/Only reads/);
    expect(() => normalizeSscRead('{"rx1":{"audio_mute":true}}')).toThrow(/Only reads/);
    expect(() => normalizeSscRead('{"osc":{"state":{"subscribe":[{"mm":null}]}}}')).toThrow(/Only reads/);
    expect(() => normalizeSscRead('{"osc":{"xid":1}}')).toThrow(/Only reads/);
    expect(() => normalizeSscRead('rx1 name')).toThrow(/addresses like/);
    expect(() => normalizeSscRead('{nope')).toThrow(/JSON/);
  });
});

describe('redactSsc', () => {
  it('removes names, serials and network identifiers', () => {
    const out = redactSsc('{"rx1":{"name":"Pastor Dan","carrier":520100},"device":{"identity":{"serial":"1234"},"network":{"ipv4":{"ipaddr":"10.0.1.40"},"mac":["00:1b:66:aa:bb:cc"]}}}', '10.0.1.40');
    expect(out).not.toMatch(/Pastor|1234|10\.0\.1\.40|00:1b:66/);
    expect(out).toContain('520100');
  });
});

describe('Inspector with Sennheiser devices', () => {
  async function setup(family: 'ewdx' | 'd6000' = 'd6000') {
    const sim = new SennheiserSim({ family, deviceName: 'Stage Left', channels: [{ name: 'Lead Vox' }, { txOn: false }] });
    const port = await sim.listen();
    const runtime = new Runtime(normalizeConfig({}), 'live');
    const inspector = new Inspector(runtime);
    cleanup.push(() => sim.close(), () => inspector.closeAll());
    return { sim, port, inspector, runtime };
  }

  it('identifies the device and sends reads', async () => {
    const { port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port, 'ssc');
    await until(() => inspector.view(id).status === 'connected' && inspector.view(id).identity?.model === 'EM 6000');
    expect(inspector.view(id).identity).toMatchObject({ kind: 'd6000', channels: 2 });
    expect(inspector.send(id, '/rx1/name')).toBe('{"rx1":{"name":null}}');
    await until(() => inspector.view(id).keys.some((k) => k.key === '/rx1/name' && k.channel === 1));
    expect(() => inspector.send(id, 'GET 1 ALL')).toThrow();
  });

  it('reads every address the device lists', async () => {
    const { sim, port, inspector } = await setup('ewdx');
    const { id } = inspector.open('127.0.0.1', port, 'ssc');
    await until(() => inspector.view(id).status === 'connected');
    inspector.readEverything(id);
    expect(inspector.view(id).reading).toBe(true);
    await until(() => !inspector.view(id).reading, 15_000);
    const keys = new Set(inspector.view(id).keys.map((k) => k.key));
    for (const a of sim.addresses()) expect(keys.has(`/${a}`) || keys.has(`/${a} (error)`)).toBe(true);
    // Channel 2 has no transmitter: its transmitter addresses answer 424.
    expect(inspector.view(id).keys.find((k) => k.key === '/mates/tx2/battery/gauge (error)')?.value).toBe('424');
    // Reads only: nothing sent carries a value.
    const sent = inspector.view(id).frames.filter((f) => f.dir === 'out').map((f) => f.frame);
    expect(sent.every((f) => !/:\s*(true|false|\d|")/.test(f.replace(/"#":\{[^}]*\}/g, '')))).toBe(true);
  }, 20_000);

  it('samples meters with a subscription and cancels it', async () => {
    const { sim, port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port, 'ssc');
    await until(() => inspector.view(id).identity?.kind === 'd6000');
    inspector.meter(id, 5);
    await until(() => inspector.view(id).keys.some((k) => k.key === '/mm' && k.count >= 2));
    expect(sim.subscriptions).toBe(1);
    inspector['stopMetering'](inspector['get'](id));
    await until(() => sim.subscriptions === 0);
  });

  it('exports an anonymized report', async () => {
    const { port, inspector } = await setup();
    const { id } = inspector.open('127.0.0.1', port, 'ssc');
    await until(() => inspector.view(id).keys.some((k) => k.key === '/device/name'));
    inspector.send(id, '/rx1/name');
    await until(() => inspector.view(id).keys.some((k) => k.key === '/rx1/name'));
    const report = inspector.report(id, true);
    const text = JSON.stringify(report);
    expect(report).toMatchObject({ protocol: 'ssc', anonymized: true, device: { host: 'redacted' } });
    expect(text).not.toContain('Stage Left');
    expect(text).not.toContain('Lead Vox');
    expect(text).not.toContain('127.0.0.1');
    expect(text).toContain('EM 6000');
  });

  it('reuses the connection of a Sennheiser receiver RF Ranger monitors', async () => {
    const { port, inspector, runtime } = await setup();
    runtime.addReceiver({ id: 'EM', family: 'd6000', host: '127.0.0.1', port, channels: 2 });
    runtime.start();
    cleanup.push(() => runtime.stop());
    const { id } = inspector.open('127.0.0.1', port);
    expect(inspector.view(id)).toMatchObject({ monitoredBy: 'EM', protocol: 'ssc' });
    inspector.send(id, '/rx1/carrier');
    await until(() => inspector.view(id).keys.some((k) => k.key === '/rx1/carrier'));
  });
});
