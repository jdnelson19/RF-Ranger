import { useEffect, useLayoutEffect, useState } from 'react';
import { Brand, StatusPill } from '../components/ui';
import { READINESS_TONE, initials, kindLabel } from '../format';
import { href, type Route } from '../route';
import type { SlotView } from '../types';
import type { Live } from '../useSnapshot';

/**
 * Artist-facing display for a TV at the RF table: identification and
 * readiness only, readable from several feet away, no interaction needed.
 */
export function Pickup({ live, route }: { live: Live; route: Route }) {
  const s = live.snapshot;
  const clock = useClock();

  const inGroup = (s?.slots ?? []).filter((x) => !route.group || x.group === route.group);
  const assigned = inGroup.filter((x) => x.assignment);
  const spares = inGroup.filter((x) => !x.assignment);
  const sections = route.group
    ? [{ name: route.group, slots: assigned }]
    : (s?.groups ?? [])
        .map((g) => ({ name: g, slots: assigned.filter((x) => x.group === g) }))
        .concat([{ name: 'Other', slots: assigned.filter((x) => !x.group) }])
        .filter((sec) => sec.slots.length > 0);

  const fitKey = `${route.group ?? ''}|${inGroup.map((x) => x.slot).join(',')}`;
  const { ref, density } = useFitDensity(fitKey);

  return (
    <div className={`pickup pickup--${density}`} ref={ref}>
      <header className="pickup__head">
        <a href={href({ view: 'launch' })} className="pickup__home" title="Back to start (Esc)"><Brand compact /></a>
        <h1 className="pickup__title">{route.group ?? 'Wireless Pickup'}</h1>
        <div className="pickup__clock">{clock}</div>
      </header>

      {!live.online && (
        <div className="pickup__offline" role="alert">
          <b>Display not connected.</b> Statuses are unknown. Please check with the audio team.
        </div>
      )}

      <main className={`pickup__body${!live.online ? ' pickup__body--offline' : ''}`}>
        {!s && <div className="empty">Connecting…</div>}
        {sections.map((sec) => (
          <section key={sec.name} className="pickup__section">
            {!route.group && <h2 className="pickup__group">{sec.name}</h2>}
            <div className="pickup__grid">
              {sec.slots.map((x) => <ArtistCard key={x.slot} s={x} online={live.online} />)}
            </div>
          </section>
        ))}

        {spares.length > 0 && (
          <section className="pickup__section">
            <h2 className="pickup__group">Spare equipment</h2>
            <div className="pickup__spares">
              {spares.map((x) => (
                <div key={x.slot} className="spare">
                  <span className="spare__label">{x.label}</span>
                  <span className="spare__kind">{kindLabel(x.kind)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {s?.demo && <div className="pickup__demo">DEMO DATA</div>}
    </div>
  );
}

function ArtistCard({ s, online }: { s: SlotView; online: boolean }) {
  const a = s.assignment!;
  const r = s.readiness;
  const tone = online ? READINESS_TONE[r.label] : 'idle';
  const [photoFailed, setPhotoFailed] = useState(false);

  let note: string | undefined;
  if (online && r.source === 'charger' && r.chargePercent !== undefined) note = `Charge ${r.chargePercent}%`;
  else if (online && r.source === 'receiver' && s.telemetry.batteryPercent.state === 'ok') note = `Battery ${s.telemetry.batteryPercent.value}%`;

  return (
    <article className={`card card--${tone}`}>
      <div className="card__status">
        {online ? <StatusPill readiness={r} size="lg" /> : <span className="pill pill--idle pill--lg">Unknown</span>}
      </div>
      <div className="card__who">
        <div className="card__avatar">
          {a.photoUrl && !photoFailed
            ? <img src={a.photoUrl} alt="" onError={() => setPhotoFailed(true)} />
            : <span>{initials(a.artist)}</span>}
        </div>
        <div className="card__names">
          <div className="card__artist">{a.artist}</div>
          {a.role && <div className="card__role">{a.role}</div>}
        </div>
      </div>
      <div className="card__gear">
        <span className="card__kind">{kindLabel(s.kind)}</span>
        <span className="card__label">{s.label}</span>
      </div>
      {note && <div className="card__note">{note}</div>}
      {a.notes && <div className="card__notes">{a.notes}</div>}
    </article>
  );
}

const DENSITIES = ['roomy', 'normal', 'dense', 'compact'] as const;
type Density = (typeof DENSITIES)[number];

/**
 * A TV can't scroll, so start with the largest cards and step down until the
 * whole display fits the screen. Re-fits when the slots shown or the window change.
 */
function useFitDensity(key: string): { ref: (el: HTMLDivElement | null) => void; density: Density } {
  const [level, setLevel] = useState(0);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(() => `${window.innerWidth}x${window.innerHeight}`);

  useEffect(() => {
    const onResize = () => setSize(`${window.innerWidth}x${window.innerHeight}`);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => setLevel(0), [key, size]);

  useLayoutEffect(() => {
    if (el && level < DENSITIES.length - 1 && el.scrollHeight > window.innerHeight + 1) setLevel(level + 1);
  });

  return { ref: setEl, density: DENSITIES[level]! };
}

function useClock(): string {
  const fmt = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = window.setInterval(() => setT(fmt()), 5_000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}
