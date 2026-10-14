import type { ReadinessLabel, Reading, Severity, SlotView } from './types';

/** Display a reading: the value, or a symbol saying why there isn't one. */
export function show<T>(r: Reading<T>, fmt: (v: T) => string = String): string {
  switch (r.state) {
    case 'ok': return fmt(r.value);
    case 'absent': return '—';
    case 'unsupported': return 'n/a';
    case 'unknown': return '…';
  }
}

export function value<T>(r: Reading<T>): T | undefined {
  return r.state === 'ok' ? r.value : undefined;
}

export function mhz(khz: number): string {
  return (khz / 1000).toFixed(3);
}

export function runtime(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export const READINESS_TEXT: Record<ReadinessLabel, string> = {
  READY: 'Ready',
  CHECK_WITH_AUDIO: 'Check with audio',
  NOT_READY: 'Not ready',
  UNASSIGNED: 'Spare',
};

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'idle';

export const READINESS_TONE: Record<ReadinessLabel, Tone> = {
  READY: 'ok',
  CHECK_WITH_AUDIO: 'warn',
  NOT_READY: 'bad',
  UNASSIGNED: 'idle',
};

export const SEVERITY_TONE: Record<Severity, Tone> = { critical: 'bad', warning: 'warn', info: 'info' };

/** Worst thing about a slot, for tile borders and sorting. */
export function slotTone(s: SlotView): Tone {
  if (s.alerts.some((a) => a.severity === 'critical')) return 'bad';
  if (s.alerts.some((a) => a.severity === 'warning')) return 'warn';
  if (!s.assignment) return 'idle';
  return 'ok';
}

export const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3, idle: 4 };

export function kindLabel(kind: SlotView['kind']): string {
  return kind === 'handheld' ? 'Handheld' : kind === 'bodypack' ? 'Bodypack' : kind === 'iem' ? 'In-ear' : 'Mic';
}
