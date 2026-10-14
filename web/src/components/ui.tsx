import type { ReactNode } from 'react';
import { READINESS_TEXT, READINESS_TONE, type Tone } from '../format';
import type { ReadinessLabel } from '../types';

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="20" r="2.6" fill="currentColor" />
      <path d="M10.3 14.3a8 8 0 0 1 11.4 0M6.6 10.6a13.2 13.2 0 0 1 18.8 0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M16 22.6V27" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand${compact ? ' brand--compact' : ''}`}>
      <span className="brand__mark"><Logo /></span>
      <span className="brand__name">RF<b>Ranger</b></span>
    </span>
  );
}

export function DemoBanner() {
  return (
    <div className="demo-banner" role="status">
      DEMO · simulated hardware · not live telemetry
    </div>
  );
}

const STATUS_ICON: Record<Tone, string> = { ok: '✓', warn: '!', bad: '✕', info: 'i', idle: '–' };

export function StatusPill({ label, size = 'sm' }: { label: ReadinessLabel; size?: 'sm' | 'lg' }) {
  const tone = READINESS_TONE[label];
  return (
    <span className={`pill pill--${tone} pill--${size}`}>
      <span className="pill__icon" aria-hidden="true">{STATUS_ICON[tone]}</span>
      {READINESS_TEXT[label]}
    </span>
  );
}

export function ToneIcon({ tone }: { tone: Tone }) {
  return <span className={`tone-icon tone-icon--${tone}`} aria-hidden="true">{STATUS_ICON[tone]}</span>;
}

/** Horizontal level meter. `value` undefined renders an empty, hatched track. */
export function Meter({ value, min, max, warnBelow, label, readout }: {
  value: number | undefined;
  min: number;
  max: number;
  warnBelow?: number;
  label: string;
  readout: string;
}) {
  const pct = value === undefined ? 0 : Math.max(0, Math.min(1, (value - min) / (max - min))) * 100;
  const weak = value !== undefined && warnBelow !== undefined && value < warnBelow;
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className={`meter__track${value === undefined ? ' meter__track--none' : ''}`}>
        <span className={`meter__fill${weak ? ' meter__fill--weak' : ''}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="meter__readout">{readout}</span>
    </div>
  );
}

/** Five-segment battery gauge, matching transmitter bars. */
export function Battery({ bars, percent, tone }: { bars: number | undefined; percent: number | undefined; tone: Tone }) {
  const level = bars ?? (percent !== undefined ? Math.ceil(percent / 20) : undefined);
  return (
    <span className={`battery battery--${level === undefined ? 'none' : tone}`} aria-label={level === undefined ? 'Battery unknown' : `Battery ${level} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`battery__seg${level !== undefined && i <= level ? ' battery__seg--on' : ''}`} />
      ))}
      <span className="battery__nub" />
    </span>
  );
}

export function Chip({ active, onClick, children, count }: { active?: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button type="button" className={`chip${active ? ' chip--active' : ''}`} onClick={onClick} aria-pressed={active}>
      {children}
      {count !== undefined && <span className="chip__count">{count}</span>}
    </button>
  );
}

/**
 * Link status, plus the version of the RF Ranger server this screen is
 * talking to (from the snapshot), so it's easy to confirm an update took.
 */
export function ServerLink({ online, version }: { online: boolean; version?: string }) {
  return (
    <span className="server-link">
      <span className={`link-state link-state--${online ? 'on' : 'off'}`} title={online ? 'Live link to RF Ranger server' : 'No link to RF Ranger server'}>
        <span className="link-state__dot" />
        {online ? 'Live' : 'Offline'}
      </span>
      {version && <span className="server-link__version" title={`RF Ranger ${version}`}>v{version}</span>}
    </span>
  );
}
