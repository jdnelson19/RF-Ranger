import { describe, expect, it } from 'vitest';
import { emptyTelemetry, type ChannelTelemetry, type ConnectionStatus } from '../src/core/model.js';
import { absent, ok } from '../src/core/reading.js';
import { readiness, type ReadinessInput } from '../src/core/readiness.js';

const NOW = 1_000_000;
const connected: ConnectionStatus = { state: 'connected', since: NOW - 60_000, lastMessageAt: NOW - 200 };

function healthy(): ChannelTelemetry {
  return {
    ...emptyTelemetry(),
    txModel: ok('AD2', NOW),
    batteryBars: ok(5, NOW),
    batteryPercent: ok(90, NOW),
    encryptionFault: ok(false, NOW),
    interference: ok(false, NOW),
    unregisteredTx: ok(false, NOW),
  };
}

function check(patch: Partial<ChannelTelemetry> = {}, extra: Partial<ReadinessInput> = {}) {
  return readiness({ assigned: true, connection: connected, telemetry: { ...healthy(), ...patch }, now: NOW, ...extra });
}

describe('readiness', () => {
  it('is READY when everything is fresh and good', () => {
    expect(check()).toMatchObject({ label: 'READY' });
  });

  it('is UNASSIGNED for a spare that is switched off', () => {
    const off = { txModel: absent(NOW), batteryBars: absent(NOW), batteryPercent: absent(NOW) };
    expect(check(off, { assigned: false })).toEqual({ label: 'UNASSIGNED', status: 'Spare' });
  });

  it('judges a switched-on spare like any other mic, so "RF-4" still shows its battery', () => {
    expect(check({}, { assigned: false })).toMatchObject({ label: 'READY' });
    expect(check({ batteryPercent: ok(30, NOW) }, { assigned: false })).toMatchObject({ label: 'NOT_READY', status: 'Battery low' });
  });

  it('is NOT_READY when the receiver is disconnected', () => {
    expect(check({}, { connection: { state: 'disconnected', since: NOW } })).toMatchObject({ label: 'NOT_READY', reason: 'Receiver offline' });
  });

  it('is NOT_READY when the receiver has gone silent, even if "connected"', () => {
    expect(check({}, { connection: { ...connected, lastMessageAt: NOW - 10_000 } }).reason).toBe('Receiver offline');
  });

  it('is NOT_READY when the wrong transmitter is on the channel', () => {
    const r = check({ txDeviceId: ok('Pastor', NOW) }, { expectedTxDeviceId: 'LeadVox' });
    expect(r).toMatchObject({ label: 'NOT_READY', reason: 'Wrong transmitter: expected LeadVox, seeing Pastor' });
  });

  it('accepts the expected transmitter', () => {
    expect(check({ txDeviceId: ok('LeadVox', NOW) }, { expectedTxDeviceId: 'LeadVox' }).label).toBe('READY');
  });

  it('is NOT_READY on a device fault', () => {
    expect(check({ encryptionFault: ok(true, NOW) }).reason).toBe('Encryption mismatch');
    expect(check({ interference: ok(true, NOW) }).reason).toBe('RF interference');
  });

  it('is NOT_READY when the battery is critical', () => {
    expect(check({ batteryPercent: ok(15, NOW) }).reason).toBe('Battery critical');
    expect(check({ batteryPercent: absent(NOW), batteryBars: ok(1, NOW) }).reason).toBe('Battery critical');
  });

  it('is STANDBY (orange) when the transmitter is off', () => {
    const r = check({ txModel: absent(NOW), batteryBars: absent(NOW), batteryPercent: absent(NOW) });
    expect(r).toMatchObject({ label: 'STANDBY', status: 'Off', reason: 'Transmitter off or out of range' });
  });

  it('never treats a stale battery reading as good', () => {
    const old = NOW - 10 * 60_000;
    const r = check({ batteryBars: ok(5, old), batteryPercent: ok(95, old) });
    expect(r).toMatchObject({ label: 'STANDBY', reason: 'Battery level unknown' });
  });

  it('is NOT_READY (red) when the battery is low', () => {
    expect(check({ batteryPercent: ok(40, NOW) })).toMatchObject({ label: 'NOT_READY', status: 'Battery low' });
    expect(check({ batteryPercent: absent(NOW), batteryBars: ok(3, NOW) }).reason).toBe('Battery low');
  });

  it('goes by the percentage, not Shure\'s bars, when the transmitter reports one', () => {
    expect(check({ batteryPercent: ok(70, NOW), batteryBars: ok(3, NOW) }).label).toBe('READY');
    expect(check({ batteryPercent: ok(45, NOW), batteryBars: ok(5, NOW) }).reason).toBe('Battery low');
  });

  it('uses bars alone for AA batteries', () => {
    expect(check({ batteryPercent: absent(NOW), batteryBars: ok(5, NOW) }).label).toBe('READY');
  });
});
