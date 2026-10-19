import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BAY_REPORTS, ShureCharger } from '../src/adapters/shure/charger.js';
import { ShureFramer, parseMessage } from '../src/adapters/shure/protocol.js';
import { emptyBay, emptyTelemetry, type BayTelemetry, type ConnectionStatus } from '../src/core/model.js';
import { absent, ok } from '../src/core/reading.js';
import { readiness } from '../src/core/readiness.js';

const NOW = 1_000_000;

function bay(frames: string[]): BayTelemetry {
  const b = emptyBay();
  for (const f of frames) {
    const m = parseMessage(f);
    if (m.kind === 'rep') BAY_REPORTS[m.key]?.(b, m.args, NOW);
  }
  return b;
}

describe('charger bay parsing', () => {
  it('reads a charging battery', () => {
    const b = bay(['< REP 1 BATT_DETECTED YES >', '< REP 1 BATT_CHARGE 072 >', '< REP 1 BATT_TIME_TO_FULL 00045 >', '< REP 1 BATT_ERROR 000 >']);
    expect(b.batteryPresent).toMatchObject({ value: true });
    expect(b.chargePercent).toMatchObject({ value: 72 });
    expect(b.minutesToFull).toMatchObject({ value: 45 });
    expect(b.full).toMatchObject({ value: false });
    expect(b.error).toMatchObject({ state: 'ok', value: null });
  });

  it('treats 65529 as full, not as minutes', () => {
    const b = bay(['< REP 2 BATT_TIME_TO_FULL 65529 >']);
    expect(b.minutesToFull).toMatchObject({ value: 0 });
    expect(b.full).toMatchObject({ value: true });
  });

  it('treats calculating / error / removed as absent', () => {
    for (const v of ['65533', '65534', '65535']) {
      expect(bay([`< REP 1 BATT_TIME_TO_FULL ${v} >`]).minutesToFull.state).toBe('absent');
    }
  });

  it('decodes battery errors', () => {
    expect(bay(['< REP 1 BATT_ERROR 004 >']).error).toMatchObject({ value: 'Charge failed' });
    expect(bay(['< REP 1 BATT_ERROR 255 >']).error.state).toBe('absent');
  });
});

describe('readiness of a docked transmitter', () => {
  const connected: ConnectionStatus = { state: 'connected', since: 0, lastMessageAt: NOW - 100 };
  const txOff = { ...emptyTelemetry(), txModel: absent(NOW), batteryBars: absent(NOW) };

  function check(b: BayTelemetry | undefined, extra: { storageMode?: boolean; charger?: ConnectionStatus } = {}) {
    return readiness({
      assigned: true,
      connection: connected,
      telemetry: txOff,
      storage: { connection: extra.charger ?? connected, bay: b, storageMode: extra.storageMode },
      now: NOW,
    });
  }

  const docked = (pct: number): BayTelemetry => ({
    ...emptyBay(),
    batteryPresent: ok(true, NOW),
    chargePercent: ok(pct, NOW),
    minutesToFull: ok(20, NOW),
    error: ok(null, NOW),
  });

  it('is STANDBY (orange) when docked and charged: the transmitter is not on yet', () => {
    expect(check(docked(95))).toEqual({ label: 'STANDBY', status: 'On charger', reason: 'On charger, 95%', source: 'charger', chargePercent: 95 });
  });

  it('is STANDBY while still charging', () => {
    expect(check(docked(60))).toMatchObject({ label: 'STANDBY', status: 'Charging', reason: 'Charging, 60%, full in 20 min' });
  });

  it('flags a transmitter that is off and missing from its bay', () => {
    const b = { ...emptyBay(), batteryPresent: ok(false, NOW) };
    expect(check(b)).toMatchObject({ label: 'STANDBY', status: 'Off', reason: 'Transmitter off and not on its charger' });
  });

  it('is NOT_READY on a charger fault', () => {
    expect(check({ ...docked(95), error: ok('Check battery', NOW) })).toMatchObject({ label: 'NOT_READY', reason: 'Charger: Check battery' });
  });

  it('does not trust bay data from an offline charger', () => {
    expect(check(docked(100), { charger: { state: 'disconnected', since: 0 } }).reason).toBe('Transmitter off; charger offline');
  });

  it('says when the charger is in storage mode', () => {
    expect(check(docked(100), { storageMode: true })).toMatchObject({ label: 'STANDBY', status: 'Storage mode' });
  });

  it('prefers live receiver data once the transmitter is switched on', () => {
    const r = readiness({
      assigned: true,
      connection: connected,
      telemetry: { ...emptyTelemetry(), txModel: ok('AD2', NOW), batteryBars: ok(5, NOW), batteryPercent: ok(30, NOW) },
      storage: { connection: connected, bay: docked(100) },
      now: NOW,
    });
    expect(r).toMatchObject({ label: 'NOT_READY', status: 'Battery low', reason: 'Battery low', source: 'receiver' });
  });
});

describe('ShureCharger', () => {
  let server: net.Server | undefined;
  let charger: ShureCharger | undefined;
  afterEach(async () => {
    await charger?.stop();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  it('discovers bays across a ganged system and keeps the link alive by polling', async () => {
    const received: string[] = [];
    server = net.createServer((s) => {
      const framer = new ShureFramer();
      s.setEncoding('ascii');
      s.on('error', () => {});
      s.on('data', (chunk: string) => {
        for (const f of framer.push(chunk)) {
          received.push(f);
          if (f === '< GET 0 ALL >') {
            s.write('< REP 1 BATT_DETECTED YES >< REP 1 BATT_CHARGE 100 >< REP 1 BATT_TIME_TO_FULL 65529 >');
            s.write('< REP 3 BATT_DETECTED NO >< REP 3 BATT_TIME_TO_FULL 65535 >');
          } else if (f === '< GET MODEL >') s.write('< REP MODEL {SBC220                        } >');
          else if (f === '< GET DEVICE_ID >') s.write('< REP DEVICE_ID {Charger A                     } >');
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    charger = new ShureCharger({ id: 'c1', host: '127.0.0.1', port, silenceTimeoutMs: 1_500 });
    charger.start();

    const deadline = Date.now() + 4_000;
    while ((charger.bays.size < 2 || received.filter((f) => f === '< GET DEVICE_ID >').length < 2) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(charger.info.model).toBe('SBC220');
    expect(charger.bays.get(1)).toMatchObject({ chargePercent: { value: 100 }, full: { value: true } });
    expect(charger.bays.get(3)).toMatchObject({ batteryPresent: { value: false } });
    // Heartbeat polled again after the initial GET, and the link stayed up.
    expect(received.filter((f) => f === '< GET DEVICE_ID >').length).toBeGreaterThanOrEqual(2);
    expect(charger.status.state).toBe('connected');
  });
});
