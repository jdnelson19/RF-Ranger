/**
 * The last few seconds of audio and RF level for one channel, so the engineer
 * can look back at a dropout or a pop and tell an RF problem (RF dips, audio
 * cuts out) from a handling noise (RF steady, audio spikes).
 */

/** What the UI draws: fixed-width bins, oldest first. `null` means no sample landed in that bin. */
export interface LevelHistory {
  /** Server time at the end of the last bin. */
  end: number;
  stepMs: number;
  /** Loudest audio in each bin, dBFS (peak where the family meters it, else RMS). */
  audio: (number | null)[];
  /** Weakest strongest-antenna RSSI in each bin, dBm. */
  rf: (number | null)[];
}

export const HISTORY_WINDOW_MS = 5_000;
export const HISTORY_STEP_MS = 100;
/** Longest run of sample-less bins bridged as jitter; longer means samples stopped. */
const MAX_CARRY_BINS = 2;

interface Sample {
  at: number;
  audio?: number;
  rf?: number;
}

export class LevelRecorder {
  private samples: Sample[] = [];

  constructor(private readonly keepMs = HISTORY_WINDOW_MS + 1_000) {}

  /** Record one meter sample. Missing values (transmitter off) are kept as gaps. */
  add(at: number, audio: number | undefined, rf: number | undefined): void {
    this.samples.push({ at, audio, rf });
    const cutoff = at - this.keepMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.at < cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  bins(now: number, windowMs = HISTORY_WINDOW_MS, stepMs = HISTORY_STEP_MS): LevelHistory {
    const count = Math.round(windowMs / stepMs);
    const start = now - count * stepMs;
    const audio: (number | null)[] = new Array(count).fill(null);
    const rf: (number | null)[] = new Array(count).fill(null);
    const heard: boolean[] = new Array(count).fill(false);
    for (const s of this.samples) {
      if (s.at <= start || s.at > now) continue;
      const i = Math.min(count - 1, Math.floor((s.at - start) / stepMs));
      heard[i] = true;
      if (s.audio !== undefined) audio[i] = Math.max(audio[i] ?? -Infinity, s.audio);
      if (s.rf !== undefined) rf[i] = Math.min(rf[i] ?? Infinity, s.rf);
    }
    // Samples come about once per bin, so timing jitter leaves the odd bin with
    // no sample at all. Carry the previous bin across a short miss rather than
    // drawing a dropout. A sample that arrived without a value (RF lost,
    // transmitter off) is a real gap and stays empty.
    for (let i = 1, miss = 0; i < count; i++) {
      if (heard[i]) {
        miss = 0;
      } else if (++miss <= MAX_CARRY_BINS) {
        audio[i] = audio[i - 1]!;
        rf[i] = rf[i - 1]!;
      }
    }
    return { end: now, stepMs, audio, rf };
  }
}
