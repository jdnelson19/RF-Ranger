import { afterEach, describe, expect, it } from 'vitest';
import { ShureReceiver } from '../src/adapters/shure/receiver.js';
import { ShureSim } from '../src/sim/shure-sim.js';
import type { ShureFamilyId } from '../src/adapters/shure/families.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(family: ShureFamilyId, opts: { silenceTimeoutMs?: number } = {}) {
  const sim = new ShureSim({ family, fragment: true });
  const port = await sim.listen();
  const rx = new ShureReceiver({ id: 'rx1', host: '127.0.0.1', port, family, meterRateMs: 100, ...opts });
  cleanup.push(() => sim.close().catch(() => {}), () => rx.stop());
  return { sim, rx, port };
}

async function until(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.each<ShureFamilyId>(['ulxd', 'axd', 'slxd'])('ShureReceiver against simulated %s', (family) => {
  it('connects, reads channel state and meters', async () => {
    const { sim, rx } = await setup(family);
    sim.channels[0]!.name = 'Lead Vox';
    sim.channels[0]!.batteryBars = 4;
    rx.start();

    await until(() => rx.channels.get(1)!.telemetry.rfDbm.state === 'ok');
    const t = rx.channels.get(1)!.telemetry;
    expect(rx.status.state).toBe('connected');
    expect(t.name).toMatchObject({ state: 'ok', value: 'Lead Vox' });
    expect(t.batteryBars).toMatchObject({ state: 'ok', value: 4 });
    expect(t.frequencyKhz).toMatchObject({ state: 'ok', value: 470_125 });
    await until(() => rx.info.model !== undefined);
    expect(rx.info.model).toBe(sim.model);
  });

  it('reflects a transmitter switching off', async () => {
    const { sim, rx } = await setup(family);
    rx.start();
    await until(() => rx.channels.get(2)!.telemetry.batteryBars.state === 'ok');
    sim.update(2, { txOn: false });
    // The sim splits writes with pauses, so the model can land a few ms after the battery.
    await until(() => rx.channels.get(2)!.telemetry.batteryBars.state === 'absent' && rx.channels.get(2)!.telemetry.txModel.state !== 'ok');
    expect(rx.channels.get(2)!.telemetry.txModel.state).toBe('absent');
  });
});

describe('ShureReceiver polling', () => {
  it('keeps an unchanging battery reading fresh by re-reading it', async () => {
    const sim = new ShureSim({ family: 'axd' });
    const port = await sim.listen();
    const rx = new ShureReceiver({ id: 'rx', host: '127.0.0.1', port, family: 'axd', pollIntervalMs: 150 });
    cleanup.push(() => sim.close(), () => rx.stop());
    rx.start();

    const bars = () => rx.channels.get(1)!.telemetry.batteryBars;
    await until(() => bars().state === 'ok');
    const first = bars();
    if (first.state !== 'ok') throw new Error('unreachable');
    await until(() => { const b = bars(); return b.state === 'ok' && b.at > first.at + 250; });
    expect(bars()).toMatchObject({ state: 'ok', value: first.value });
  });
});

describe('ShureReceiver connection handling', () => {
  it('reconnects after the receiver drops the connection', async () => {
    const { sim, rx } = await setup('ulxd');
    const states: string[] = [];
    rx.on('status', (s) => states.push(s.state));
    rx.start();
    await until(() => rx.status.state === 'connected');
    sim.dropClients();
    await until(() => states.includes('disconnected'));
    await until(() => rx.status.state === 'connected');
    expect(states).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
  });

  it('drops a connection that goes silent', async () => {
    const { sim, rx } = await setup('ulxd', { silenceTimeoutMs: 400 });
    rx.start();
    await until(() => rx.status.state === 'connected');
    // Stop metering on the sim side so nothing more arrives.
    for (const ch of [1, 2, 3, 4]) rx.send(`< SET ${ch} METER_RATE 00000 >`);
    await until(() => rx.status.state === 'disconnected' || rx.status.state === 'connecting');
    expect(rx.status.lastError).toMatch(/No data/);
    void sim;
  });

  it('turns metering off before closing', async () => {
    const { rx } = await setup('axd');
    const sent: string[] = [];
    rx.on('wire', (dir, frame) => dir === 'out' && sent.push(frame));
    rx.start();
    await until(() => rx.status.state === 'connected');
    await rx.stop();
    expect(sent.slice(-4)).toEqual([1, 2, 3, 4].map((ch) => `< SET ${ch} METER_RATE 00000 >`));
  });

  it('reports a receiver that is not there', async () => {
    const rx = new ShureReceiver({ id: 'nope', host: '127.0.0.1', port: 1, family: 'ulxd' });
    cleanup.push(() => rx.stop());
    rx.start();
    await until(() => rx.status.state === 'disconnected' && rx.status.lastError !== undefined);
    expect(rx.status.lastError).toBeTruthy();
  });
});
