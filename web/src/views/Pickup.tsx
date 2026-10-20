import { useEffect, useLayoutEffect, useState } from 'react';
import { Brand, StatusPill } from '../components/ui';
import { READINESS_TONE, initials, kindLabel, shownReadiness } from '../format';
import { href, type Route } from '../route';
import type { ShowPreset, SlotView } from '../types';
import type { Live } from '../useSnapshot';

/**
 * Artist-facing display for a TV at the RF table: identification and
 * readiness only, readable from several feet away, no interaction needed.
 *
 * With a show preset (#/pickup?show=<id>) it shows just that preset's
 * channels, in its order, with its nicknames: on a shared network the room's
 * own mics, not every receiver RF Ranger can see. Cards fill top to bottom,
 * then the next column, the way mics are laid out on a table.
 */
export function Pickup({ live, route }: { live: Live; route: Route }) {
  const s = live.snapshot;
  const clock = useClock();
  const preset = route.show ? s?.presets.find((p) => p.id === route.show) : undefined;
  const nickname = (x: SlotView) => preset?.channels?.[x.key]?.nickname;

  const inView = presetSlots(s?.slots ?? [], preset).filter((x) => !route.group || x.group === route.group);
  const assigned = inView.filter((x) => x.assignment || nickname(x));
  const spares = inView.filter((x) => !x.assignment && !nickname(x));
  // A preset already says what goes on this screen and in what order: one section.
  const sections = preset || route.group
    ? [{ name: preset?.name ?? route.group!, slots: assigned }]
    : (s?.groups ?? [])
        .map((g) => ({ name: g, slots: assigned.filter((x) => x.group === g) }))
        .concat([{ name: 'Other', slots: assigned.filter((x) => !x.group) }])
        .filter((sec) => sec.slots.length > 0);

  const fitKey = `${route.group ?? ''}|${route.show ?? ''}|${inView.map((x) => x.slot).join(',')}`;
  const { ref, density, columns } = useFit(`${fitKey}|${preset?.pickupColumns ?? ''}`, preset?.pickupColumns);
  const missingPreset = !!route.show && !!s && !preset;

  return (
    <div className={`pickup pickup--${density}${preset?.pickupColumns ? " pickup--strips" : ""}`} ref={ref}>
      <header className="pickup__head">
        <a href={href({ view: 'launch' })} className="pickup__home" title="Back to start (Esc)"><Brand compact /></a>
        <h1 className="pickup__title">{preset?.name ?? route.group ?? 'Wireless Pickup'}</h1>
        <div className="pickup__clock">{clock}</div>
      </header>

      {!live.online && (
        <div className="pickup__offline" role="alert">
          <b>Display not connected.</b> Statuses are unknown. Please check with the audio team.
        </div>
      )}

      <main className={`pickup__body${!live.online ? ' pickup__body--offline' : ''}`}>
        {!s && <div className="empty">Connecting…</div>}
        {missingPreset && <div className="empty">This display's show preset was deleted. Choose another from the start screen.</div>}
        {sections.map((sec) => (
          <section key={sec.name} className="pickup__section">
            {sections.length > 1 && <h2 className="pickup__group">{sec.name}</h2>}
            <div className="pickup__grid" style={{ gridTemplateRows: `repeat(${Math.max(1, Math.ceil(sec.slots.length / columns))}, auto)` }}>
              {sec.slots.map((x) => <ArtistCard key={x.key} s={x} nickname={nickname(x)} online={live.online} />)}
            </div>
          </section>
        ))}

        {spares.length > 0 && (
          <section className="pickup__section">
            <h2 className="pickup__group">Spare equipment</h2>
            <div className="pickup__spares">
              {spares.map((x) => (
                <div key={x.key} className="spare">
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

/** The preset's channels in its order (missing ones skipped), or every channel. */
function presetSlots(slots: SlotView[], preset: ShowPreset | undefined): SlotView[] {
  if (!preset) return slots;
  const byKey = new Map(slots.map((x) => [x.key, x]));
  return preset.slots.map((k) => byKey.get(k)).filter((x): x is SlotView => !!x);
}

function ArtistCard({ s, nickname, online }: { s: SlotView; nickname?: string; online: boolean }) {
  const a = s.assignment;
  const r = shownReadiness(s, nickname);
  const tone = online ? READINESS_TONE[r.label] : 'idle';
  const [photoFailed, setPhotoFailed] = useState(false);
  const name = nickname ?? a?.artist ?? s.label;

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
          {a?.photoUrl && !photoFailed && !nickname
            ? <img src={a.photoUrl} alt="" onError={() => setPhotoFailed(true)} />
            : <span>{initials(name)}</span>}
        </div>
        <div className="card__names">
          <div className="card__artist">{name}</div>
          {a?.role && <div className="card__role">{a.role}</div>}
        </div>
      </div>
      <div className="card__gear">
        <span className="card__kind">{kindLabel(s.kind)}</span>
        <span className="card__label">{s.label}</span>
      </div>
      {note && <div className="card__note">{note}</div>}
      {a?.notes && <div className="card__notes">{a.notes}</div>}
    </article>
  );
}

const DENSITIES = ['roomy', 'normal', 'dense', 'compact'] as const;
type Density = (typeof DENSITIES)[number];
const CARD_GAP = 16;

/**
 * A TV can't scroll, so start with the largest cards and step down until the
 * whole display fits the screen. Columns are the preset's choice, or as many
 * cards as fit across at that size; cards then fill each column top to
 * bottom. Re-fits when the slots shown or the window change.
 */
function useFit(key: string, fixedColumns?: number): { ref: (el: HTMLDivElement | null) => void; density: Density; columns: number } {
  const [level, setLevel] = useState(0);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState(() => `${window.innerWidth}x${window.innerHeight}`);
  const [columns, setColumns] = useState(1);

  useEffect(() => {
    const onResize = () => setSize(`${window.innerWidth}x${window.innerHeight}`);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => setLevel(0), [key, size]);

  useLayoutEffect(() => {
    if (!el) return;
    const body = el.querySelector<HTMLElement>('.pickup__body');
    const cardVar = getComputedStyle(el).getPropertyValue('--card-w').trim();
    // Phones size cards as a percentage: one column.
    const cardW = cardVar.endsWith('%') ? Infinity : parseFloat(cardVar) || 320;
    const width = body ? body.clientWidth - parseFloat(getComputedStyle(body).paddingLeft) - parseFloat(getComputedStyle(body).paddingRight) : el.clientWidth;
    const fit = Math.max(1, Math.floor((width + CARD_GAP) / (cardW + CARD_GAP)));
    // A phone always gets one column; otherwise the preset's count wins.
    const want = cardW === Infinity ? 1 : fixedColumns ?? fit;
    if (want !== columns) {
      setColumns(want);
      return; // lay out with the new column count before judging the size
    }
    // Fixed columns share the width (strip cards), so only the height has to fit.
    if (level < DENSITIES.length - 1 && el.scrollHeight > window.innerHeight + 1) setLevel(level + 1);
  });

  return { ref: setEl, density: DENSITIES[level]!, columns };
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
