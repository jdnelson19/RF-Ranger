import { describe, expect, it } from 'vitest';
import { SHURE_FAMILIES, initialTelemetry, numeric } from '../src/adapters/shure/families.js';
import { parseMessage } from '../src/adapters/shure/protocol.js';
import type { ChannelTelemetry } from '../src/core/model.js';

const NOW = 1_000;

function feed(familyId: keyof typeof SHURE_FAMILIES, frames: string[]): ChannelTelemetry {
  const family = SHURE_FAMILIES[familyId];
  const t = initialTelemetry(family);
  for (const frame of frames) {
    const m = parseMessage(frame);
    if (m.kind === 'rep') family.reports[m.key]?.(t, m.args, NOW);
    if (m.kind === 'sample') family.applySample(t, m.args, NOW);
  }
  return t;
}

describe('numeric sentinels', () => {
  it.each([
    ['255', 'absent'],
    ['252', 'absent'],
    ['251', 'ok'],
    ['000', 'ok'],
    ['65535', 'absent'],
    ['65532', 'absent'],
    ['00125', 'ok'],
    ['abc', 'absent'],
  ])('%s -> %s', (raw, state) => {
    expect(numeric(raw, NOW).state).toBe(state);
  });
});

describe('ULX-D', () => {
  it('reads battery from a rechargeable transmitter', () => {
    const t = feed('ulxd', ['< REP 1 BATT_BARS 004 >', '< REP 1 BATT_CHARGE 076 >', '< REP 1 BATT_RUN_TIME 00185 >']);
    expect(t.batteryBars).toEqual({ state: 'ok', value: 4, at: NOW });
    expect(t.batteryPercent).toEqual({ state: 'ok', value: 76, at: NOW });
    expect(t.batteryRuntimeMin).toEqual({ state: 'ok', value: 185, at: NOW });
  });

  it('treats AA batteries / TX off as absent, not zero', () => {
    const t = feed('ulxd', ['< REP 1 BATT_BARS 255 >', '< REP 1 BATT_CHARGE 255 >', '< REP 1 BATT_RUN_TIME 65535 >']);
    expect(t.batteryBars.state).toBe('absent');
    expect(t.batteryPercent.state).toBe('absent');
    expect(t.batteryRuntimeMin.state).toBe('absent');
  });

  it('converts samples to dBm and dBFS', () => {
    const t = feed('ulxd', ['< SAMPLE 1 ALL AX 068 035 >']);
    expect(t.antennas).toEqual({ state: 'ok', value: 'AX', at: NOW });
    expect(t.rfDbm).toEqual({ state: 'ok', value: [-60], at: NOW });
    expect(t.audioRmsDbfs).toEqual({ state: 'ok', value: -15, at: NOW });
  });

  it('takes identity and mute from any transmitter that reports them, whatever the model', () => {
    // A ULXD1 on current firmware reports mute status, despite the 2018 bulletin.
    const t = feed('ulxd', ['< REP 1 TX_MUTE_STATUS OFF >', '< REP 1 TX_TYPE ULXD1 >', '< REP 1 TX_DEVICE_ID {PACK07  } >']);
    expect(t.txMuted).toEqual({ state: 'ok', value: false, at: NOW });
    expect(t.txDeviceId).toEqual({ state: 'ok', value: 'PACK07', at: NOW });
    // A blank identity is "nothing reported", never a mismatch.
    expect(feed('ulxd', ['< REP 1 TX_TYPE ULXD2 >', '< REP 1 TX_DEVICE_ID {        } >']).txDeviceId.state).toBe('absent');
  });

  it('flags RF interference and encryption mismatch', () => {
    const t = feed('ulxd', ['< REP 1 RF_INT_DET CRITICAL >', '< REP 1 ENCRYPTION_WARNING ON >']);
    expect(t.interference).toEqual({ state: 'ok', value: true, at: NOW });
    expect(t.encryptionFault).toEqual({ state: 'ok', value: true, at: NOW });
  });

  it('does not report link quality', () => {
    expect(initialTelemetry(SHURE_FAMILIES.ulxd).linkQuality.state).toBe('unsupported');
  });
});

describe('Axient Digital', () => {
  it('parses a standard sample with both antennas', () => {
    const t = feed('axd', ['< SAMPLE 1 ALL 005 031 102 090 BB 31 086 31 065 >']);
    expect(t.linkQuality).toEqual({ state: 'ok', value: 5, at: NOW });
    expect(t.audioPeakDbfs).toEqual({ state: 'ok', value: -18, at: NOW });
    expect(t.audioRmsDbfs).toEqual({ state: 'ok', value: -30, at: NOW });
    expect(t.rfDbm).toEqual({ state: 'ok', value: [-34, -55], at: NOW });
  });

  it('parses a Quadversity sample with four antennas', () => {
    const t = feed('axd', ['< SAMPLE 1 ALL 005 031 102 102 BBBB 31 083 31 068 31 069 31 072 >']);
    expect(t.rfDbm).toEqual({ state: 'ok', value: [-37, -52, -51, -48], at: NOW });
  });

  it('reports link quality 255 as absent', () => {
    expect(feed('axd', ['< SAMPLE 1 ALL 255 000 000 000 XX 00 000 00 000 >']).linkQuality.state).toBe('absent');
  });

  it('applies the -12 dB transmitter offset encoding', () => {
    expect(feed('axd', ['< REP 1 TX_OFFSET 012 >']).txOffsetDb).toEqual({ state: 'ok', value: 0, at: NOW });
    expect(feed('axd', ['< REP 1 TX_OFFSET 255 >']).txOffsetDb.state).toBe('absent');
  });

  it('reads transmitter identity and mute switch', () => {
    const t = feed('axd', ['< REP 1 TX_DEVICE_ID {LeadVox                        } >', '< REP 1 TX_MUTE_MODE_STATUS MUTE >']);
    expect(t.txDeviceId).toEqual({ state: 'ok', value: 'LeadVox', at: NOW });
    expect(t.txMuted).toEqual({ state: 'ok', value: true, at: NOW });
  });

  it('treats a blank transmitter ID as absent', () => {
    expect(feed('axd', ['< REP 1 TX_DEVICE_ID {                               } >']).txDeviceId.state).toBe('absent');
  });
});

describe('SLX-D', () => {
  it('parses the three-field sample', () => {
    const t = feed('slxd', ['< SAMPLE 1 ALL 102 102 086 >']);
    expect(t.audioPeakDbfs).toEqual({ state: 'ok', value: -18, at: NOW });
    expect(t.rfDbm).toEqual({ state: 'ok', value: [-34], at: NOW });
  });

  it('does not claim transmitter identity', () => {
    expect(initialTelemetry(SHURE_FAMILIES.slxd).txDeviceId.state).toBe('unsupported');
  });
});
