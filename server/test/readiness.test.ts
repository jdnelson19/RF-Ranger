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
    expect(check()).toEqual({ label: 'READY' });
  });

  it('is UNASSIGNED without an assignment', () => {
    expect(check({}, { assigned: false }).label).toBe('UNASSIGNED');
  });

  it('is NOT_READY when the receiver is disconnected', () => {
    expect(check({}, { connection: { state: 'disconnected', since: NOW } })).toEqual({ label: 'NOT_READY', reason: 'Receiver offline' });
  });

  it('is NOT_READY when the receiver has gone silent, even if "connected"', () => {
    expect(check({}, { connection: { ...connected, lastMessageAt: NOW - 10_000 } }).reason).toBe('Receiver offline');
  });

  it('is NOT_READY when the wrong transmitter is on the channel', () => {
    const r = check({ txDeviceId: ok('Pastor', NOW) }, { expectedTxDeviceId: 'LeadVox' });
    expect(r).toEqual({ label: 'NOT_READY', reason: 'Wrong transmitter: expected LeadVox, seeing Pastor' });
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

  it('asks to check with audio when the transmitter is off', () => {
    const r = check({ txModel: absent(NOW), batteryBars: absent(NOW), batteryPercent: absent(NOW) });
    expect(r).toEqual({ label: 'CHECK_WITH_AUDIO', reason: 'Transmitter off or out of range' });
  });

  it('never treats a stale battery reading as good', () => {
    const old = NOW - 10 * 60_000;
    const r = check({ batteryBars: ok(5, old), batteryPercent: ok(95, old) });
    expect(r).toEqual({ label: 'CHECK_WITH_AUDIO', reason: 'Battery level unknown' });
  });

  it('asks to check with audio when the battery is low', () => {
    expect(check({ batteryPercent: ok(40, NOW) }).reason).toBe('Battery low');
    expect(check({ batteryPercent: absent(NOW), batteryBars: ok(3, NOW) }).reason).toBe('Battery low');
  });

  it('uses bars alone for AA batteries', () => {
    expect(check({ batteryPercent: absent(NOW), batteryBars: ok(5, NOW) }).label).toBe('READY');
  });
});
