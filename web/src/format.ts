import type { Readiness, ReadinessLabel, Reading, Severity, SlotView } from './types';

/** Display a reading: the value, or a symbol saying why there isn't one. */
export function show<T>(r: Reading<T>, fmt: (v: T) => string = String): string {
  switch (r.state) {
    case 'ok': return fmt(r.value);
    case 'absent': return r.reason ?? '—';
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

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'idle';

/** Green ready, orange off or on its charger, red low battery or a fault. */
export const READINESS_TONE: Record<ReadinessLabel, Tone> = {
  READY: 'ok',
  STANDBY: 'warn',
  NOT_READY: 'bad',
  UNASSIGNED: 'idle',
};

export const SEVERITY_TONE: Record<Severity, Tone> = { critical: 'bad', warning: 'warn', info: 'info' };

/**
 * Readiness as this screen shows it. A channel the active preset gives a
 * nickname is someone's mic for this show, so when it's switched off it reads
 * "Off" (orange) rather than "Spare".
 */
export function shownReadiness(s: SlotView, nickname?: string): Readiness {
  if (nickname && s.readiness.label === 'UNASSIGNED') return { label: 'STANDBY', status: 'Off', reason: 'Transmitter off or out of range' };
  return s.readiness;
}

/** Worst thing about a slot, for tile borders and sorting. */
export function slotTone(s: SlotView, r: Readiness = s.readiness): Tone {
  if (s.alerts.some((a) => a.severity === 'critical') || r.label === 'NOT_READY') return 'bad';
  if (r.label === 'STANDBY' || s.alerts.some((a) => a.severity === 'warning')) return 'warn';
  if (r.label === 'UNASSIGNED') return 'idle';
  return 'ok';
}

export const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3, idle: 4 };

export function kindLabel(kind: SlotView['kind']): string {
  return kind === 'handheld' ? 'Handheld' : kind === 'bodypack' ? 'Bodypack' : kind === 'iem' ? 'In-ear' : 'Mic';
}
