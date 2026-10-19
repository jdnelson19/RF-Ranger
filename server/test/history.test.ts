import { describe, expect, it } from 'vitest';
import { LevelRecorder } from '../src/core/history.js';

describe('LevelRecorder', () => {
  it('bins the last five seconds, oldest first, keeping the loudest audio and weakest RF per bin', () => {
    const rec = new LevelRecorder();
    const now = 10_000;
    rec.add(now - 50, -30, -60);
    rec.add(now - 20, -12, -70); // same last bin: louder audio, weaker RF win
    rec.add(now - 4_950, -40, -55); // first bin
    const h = rec.bins(now);
    expect(h).toMatchObject({ end: now, stepMs: 100 });
    expect(h.audio).toHaveLength(50);
    expect(h.audio[49]).toBe(-12);
    expect(h.rf[49]).toBe(-70);
    expect(h.audio[0]).toBe(-40);
    // Carried over two sample-less bins as jitter, then empty: samples stopped.
    expect(h.audio.slice(1, 3)).toEqual([-40, -40]);
    expect(h.audio.slice(3, 49).every((v) => v === null)).toBe(true);
  });

  it('bridges a bin that a late sample missed, but not a sample that arrived with no signal', () => {
    const rec = new LevelRecorder();
    const now = 10_000;
    rec.add(now - 350, -20, -60);
    rec.add(now - 150, -22, -61); // nothing lands in the bin before this one
    rec.add(now - 50, undefined, undefined); // RF lost
    const h = rec.bins(now);
    expect(h.rf.slice(46)).toEqual([-60, -60, -61, null]);
  });

  it('leaves a gap while the transmitter is off, and forgets samples older than the window', () => {
    const rec = new LevelRecorder();
    rec.add(1_000, -20, -60);
    rec.add(9_950, undefined, undefined);
    const h = rec.bins(10_000);
    expect(h.audio.every((v) => v === null)).toBe(true);
    expect(h.rf.every((v) => v === null)).toBe(true);
  });
});
