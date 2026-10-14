import { describe, expect, it } from 'vitest';
import { ShureFramer, meterRateCommand, parseMessage, tokenize } from '../src/adapters/shure/protocol.js';

describe('ShureFramer', () => {
  it('reassembles a message split across reads', () => {
    const f = new ShureFramer();
    expect(f.push('< REP 1 BATT_')).toEqual([]);
    expect(f.push('BARS 004 >')).toEqual(['< REP 1 BATT_BARS 004 >']);
  });

  it('splits several messages in one read and keeps the trailing partial', () => {
    const f = new ShureFramer();
    expect(f.push('< REP 1 A 1 >< SAMPLE 1 ALL XX 000 000 >< REP 2')).toEqual([
      '< REP 1 A 1 >',
      '< SAMPLE 1 ALL XX 000 000 >',
    ]);
    expect(f.push(' B 2 >')).toEqual(['< REP 2 B 2 >']);
  });

  it('does not end a frame on ">" inside a braced string', () => {
    const f = new ShureFramer();
    expect(f.push('< REP 1 CHAN_NAME {A>B<C  } >')).toEqual(['< REP 1 CHAN_NAME {A>B<C  } >']);
  });

  it('ignores noise between frames', () => {
    const f = new ShureFramer();
    expect(f.push('\r\n junk < REP ERR >\r\n')).toEqual(['< REP ERR >']);
  });
});

describe('tokenize', () => {
  it('keeps braced values whole and trims padding', () => {
    expect(tokenize('REP 1 CHAN_NAME {Lead Vox      }')).toEqual(['REP', '1', 'CHAN_NAME', 'Lead Vox']);
  });

  it('turns an all-space braced value into an empty token', () => {
    expect(tokenize('REP 1 TX_DEVICE_ID {        }')).toEqual(['REP', '1', 'TX_DEVICE_ID', '']);
  });
});

describe('parseMessage', () => {
  it('parses channel reports', () => {
    expect(parseMessage('< REP 2 BATT_BARS 004 >')).toEqual({ kind: 'rep', channel: 2, key: 'BATT_BARS', args: ['004'] });
  });

  it('parses device reports', () => {
    expect(parseMessage('< REP MODEL {AD4Q-A     } >')).toEqual({ kind: 'rep', channel: undefined, key: 'MODEL', args: ['AD4Q-A'] });
  });

  it('parses multi-value reports such as Axient per-antenna RSSI', () => {
    expect(parseMessage('< REP 1 RSSI 2 064 >')).toEqual({ kind: 'rep', channel: 1, key: 'RSSI', args: ['2', '064'] });
  });

  it('parses samples', () => {
    expect(parseMessage('< SAMPLE 3 ALL AX 090 035 >')).toEqual({ kind: 'sample', channel: 3, args: ['AX', '090', '035'] });
  });

  it('recognises errors', () => {
    expect(parseMessage('< REP ERR >')).toEqual({ kind: 'err' });
  });
});

describe('meterRateCommand', () => {
  it('zero-pads to five digits', () => {
    expect(meterRateCommand(1, 100)).toBe('< SET 1 METER_RATE 00100 >');
    expect(meterRateCommand(4, 0)).toBe('< SET 4 METER_RATE 00000 >');
  });
});
