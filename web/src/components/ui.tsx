import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { READINESS_TONE, antennasInUse, antennasText, type Tone } from '../format';
import type { Readiness, SlotView, Snapshot } from '../types';

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

export function StatusPill({ readiness, size = 'sm' }: { readiness: Readiness; size?: 'sm' | 'lg' }) {
  const tone = READINESS_TONE[readiness.label];
  return (
    <span className={`pill pill--${tone} pill--${size}`}>
      <span className="pill__icon" aria-hidden="true">{STATUS_ICON[tone]}</span>
      {readiness.status}
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

/**
 * Five-segment battery gauge drawn from the percentage, one segment per 20 %
 * (Shure's own bars don't line up with the percentage). Transmitters with no
 * percentage, such as on AA cells, fall back to their bars.
 */
export function Battery({ bars, percent, tone }: { bars: number | undefined; percent: number | undefined; tone: Tone }) {
  const level = percent !== undefined ? Math.ceil(Math.max(0, Math.min(100, percent)) / 20) : bars;
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

const WAVE_FLOOR_DB = -60;
// Peaks this close to full scale are about to clip.
const WAVE_HOT_DB = -2;
const RF_FLOOR_DBM = -100;
const RF_CEIL_DBM = -30;
const RF_WEAK_DBM = -85;

/**
 * The last few seconds of a channel: audio as a waveform, RF as a strip
 * underneath. A dropout shows both dipping together (an RF problem); a bump
 * or pop shows an audio spike while RF stays steady.
 */
export function Waveform({ levels, live, tall = false }: { levels: SlotView['levels']; live: boolean; tall?: boolean }) {
  const n = levels?.audio.length ?? 50;
  const h = tall ? 56 : 30;
  const mid = h / 2;
  const seconds = levels ? Math.round((n * levels.stepMs) / 1000) : 5;
  return (
    <div className={`wave${tall ? ' wave--tall' : ''}`} aria-label={`Audio and RF level, last ${seconds} seconds`} role="img">
      <span className="meter__label">AUD</span>
      <svg className="wave__audio" viewBox={`0 0 ${n} ${h}`} preserveAspectRatio="none" style={{ height: h }}>
        <line x1="0" x2={n} y1={mid} y2={mid} className="wave__base" />
        {live && levels?.audio.map((db, i) => {
          if (db === null) return null;
          const amp = Math.max(0.6, Math.min(1, (db - WAVE_FLOOR_DB) / -WAVE_FLOOR_DB) * (mid - 1));
          return <rect key={i} x={i + 0.15} width={0.7} y={mid - amp} height={amp * 2} className={db >= WAVE_HOT_DB ? 'wave__bar wave__bar--hot' : 'wave__bar'} />;
        })}
      </svg>
      <span className="meter__readout">{seconds} s</span>
      <span className="meter__label">RF</span>
      <svg className="wave__rf" viewBox={`0 0 ${n} 1`} preserveAspectRatio="none">
        {live && levels?.rf.map((dbm, i) => {
          if (dbm === null) return null;
          const strength = Math.max(0.15, Math.min(1, (dbm - RF_FLOOR_DBM) / (RF_CEIL_DBM - RF_FLOOR_DBM)));
          return <rect key={i} x={i} width={1.02} y={0} height={1} opacity={strength} className={dbm < RF_WEAK_DBM ? 'wave__rf-bin wave__rf-bin--weak' : 'wave__rf-bin'} />;
        })}
      </svg>
      <span className="meter__readout">now</span>
    </div>
  );
}

/** A newer RF Ranger is out: a link to download it for the computer running RF Ranger. */
export function UpdateLink({ update }: { update: Snapshot['update'] }) {
  if (!update) return null;
  return (
    <a className="update-link" href={update.url} target="_blank" rel="noreferrer" title={`Download RF Ranger ${update.version} for the computer running RF Ranger`}>
      Update available: v{update.version}
    </a>
  );
}

/** Small A / B (/ C / D) lights for the diversity antennas in use. */
export function AntennaLights({ field }: { field: string }) {
  const ants = antennasInUse(field);
  if (ants.length < 2) return null;
  return (
    <span className="ant" title={`Antennas: ${antennasText(field)}`} aria-label={`Antennas: ${antennasText(field)}`}>
      {ants.map((a) => <span key={a.name} className={`ant__seg${a.on ? ' ant__seg--on' : ''}`}>{a.name}</span>)}
    </span>
  );
}

/** Who this screen is to RF Ranger's admin settings (see server/src/server/admin.ts). */
export interface AdminState {
  /** The computer running RF Ranger. */
  local: boolean;
  /** An admin password exists, so other screens can sign in. */
  passwordSet: boolean;
  signedIn: boolean;
}

export function useAdmin(): { state?: AdminState; refresh: () => void } {
  const [state, setState] = useState<AdminState>();
  const refresh = useCallback(() => {
    fetch('/api/admin').then((r) => (r.ok ? r.json() : undefined)).then(setState, () => setState(undefined));
  }, []);
  useEffect(refresh, [refresh]);
  return { state, refresh };
}

/**
 * The admin settings from another screen: a password form when an admin
 * password is set (a Raspberry Pi behind a TV has no screen of its own to
 * sit at), otherwise how to set one.
 */
export function AdminSignIn({ title, why, onSignedIn, compact = false }: { title: string; why?: string; onSignedIn: () => void; compact?: boolean }) {
  const { state } = useAdmin();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.ok) {
        setPassword('');
        onSignedIn();
      } else {
        setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Couldn’t sign in.');
      }
    } catch (e) {
      setError(`Can't reach RF Ranger: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const form = state?.passwordSet && (
    <form className="admin-signin" onSubmit={submit}>
      <input className="input" type="password" autoComplete="current-password" placeholder="Admin password" aria-label="Admin password"
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit" className="btn btn--primary" disabled={busy || !password}>Sign in</button>
      {error && <span className="admin-signin__error">{error}</span>}
    </form>
  );

  if (compact) return form || null;
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {why && <p className="dim">{why}</p>}
      {form ? (
        <>
          <p>Sign in with the admin password to use it from this screen.</p>
          {form}
        </>
      ) : (
        state && <p className="dim">To use it from other screens, set an admin password on that computer: <code>rf-ranger --set-password</code></p>
      )}
    </div>
  );
}

/** Settings menu: sign out of admin on a screen that signed in. */
export function AdminSignOut({ onDone }: { onDone?: () => void }) {
  const { state, refresh } = useAdmin();
  if (!state?.signedIn || state.local) return null;
  const signOut = async () => {
    await fetch('/api/admin/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
    refresh();
    onDone?.();
    window.location.reload();
  };
  return <button type="button" role="menuitem" className="menu__item admin-signout" onClick={() => void signOut()}>Sign out of admin</button>;
}
