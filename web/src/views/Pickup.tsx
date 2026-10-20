import { useEffect, useLayoutEffect, useState } from 'react';
import { LiveClock, LiveStrip } from '../components/LiveNow';
import { Battery, Brand, StatusPill } from '../components/ui';
import { READINESS_TONE, initials, kindLabel, shownReadiness, value } from '../format';
import { href, type Route } from '../route';
import type { ShowPreset, SlotView } from '../types';
import type { Live } from '../useSnapshot';

/**
 * Artist-facing display for a TV at the RF table: identification and
 * readiness only, readable from several feet away, no interaction needed.
 *
 * With a show preset it shows just that preset's channels, in its order,
 * with its nicknames: on a shared network the room's own mics, not every
 * receiver RF Ranger can see. #/pickup shows the preset assigned from the
 * engineer view (or every channel); a TV bookmarked to #/pickup?show=<id>
 * stays on that preset.
 *
 * The default layout is one tall column per person, Micboard style: their
 * photo as the background, then top to bottom the RF label, their name, the
 * mic's battery, and the in-ear pack paired with them. A preset with a column
 * count instead shows strip cards that fill top to bottom, then the next
 * column, the way mics are laid out on a table.
 */
export function Pickup({ live, route }: { live: Live; route: Route }) {
  const s = live.snapshot;
  const clock = useClock();
  // Its own preset if the address names one, else whatever the engineer view assigned.
  const presetId = route.show ?? s?.pickupPreset;
  const preset = presetId ? s?.presets.find((p) => p.id === presetId) : undefined;
  const nickname = (x: SlotView) => preset?.channels?.[x.key]?.nickname;

  const inView = presetSlots(s?.slots ?? [], preset).filter((x) => !route.group || x.group === route.group);
  const assigned = inView.filter((x) => x.assignment || nickname(x));
  const spares = inView.filter((x) => !x.assignment && !nickname(x));
  const strips = !!preset?.pickupColumns;
  const bySlot = new Map((s?.slots ?? []).map((x) => [x.key, x]));
  // An in-ear channel paired with someone's mic shows in that mic's column, not its own.
  const pairedIems = new Set(assigned.map((x) => x.iem).filter((k): k is string => !!k));
  const columnSlots = assigned.filter((x) => !pairedIems.has(x.key));
  // A preset already says what goes on this screen and in what order: one section.
  const sections = preset || route.group
    ? [{ name: preset?.name ?? route.group!, slots: assigned }]
    : (s?.groups ?? [])
        .map((g) => ({ name: g, slots: assigned.filter((x) => x.group === g) }))
        .concat([{ name: 'Other', slots: assigned.filter((x) => !x.group) }])
        .filter((sec) => sec.slots.length > 0);

  const fitKey = `${route.group ?? ''}|${route.show ?? ''}|${inView.map((x) => x.slot).join(',')}`;
  const { ref, density, columns } = useFit(`${fitKey}|${preset?.pickupColumns ?? ''}`, preset?.pickupColumns, !strips);
  const missingPreset = !!route.show && !!s && !preset;

  return (
    <div className={`pickup pickup--${density}${strips ? ' pickup--strips' : ' pickup--board'}`} ref={ref}>
      <header className="pickup__head">
        <a href={href({ view: 'launch' })} className="pickup__home" title="Back to start (Esc)"><Brand compact /></a>
        {/* While a service is live, its clock takes the top center; the title steps aside. */}
        {s?.live && live.online
          ? <LiveClock live={live} className="pickup__live-clock" />
          : <h1 className="pickup__title">{preset?.name ?? route.group ?? 'Wireless Pickup'}</h1>}
        <div className="pickup__clock">{clock}</div>
      </header>

      <LiveStrip live={live} showClock={false} />

      {!live.online && (
        <div className="pickup__offline" role="alert">
          <b>Display not connected.</b> Statuses are unknown. Please check with the audio team.
        </div>
      )}

      <main className={`pickup__body${!live.online ? ' pickup__body--offline' : ''}`}>
        {!s && <div className="empty">Connecting…</div>}
        {missingPreset && <div className="empty">This display's show preset was deleted. Choose another from the start screen.</div>}
        {!strips && s && columnSlots.length > 0 && (
          <Board count={columnSlots.length}>
            {columnSlots.map((x) => (
              <MicColumn key={x.key} s={x} nickname={nickname(x)} iem={x.iem ? bySlot.get(x.iem) : undefined} online={live.online} />
            ))}
          </Board>
        )}
        {strips && sections.map((sec) => (
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

/**
 * Columns sized to fill the screen: as many per row as fit at a readable
 * width, balanced across rows (8 people on a screen that fits 6 make two rows
 * of 4), every row the same height.
 */
function Board({ count, children }: { count: number; children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [el]);
  const fit = Math.max(1, Math.floor((width + COLUMN_GAP) / (MIN_COLUMN_W + COLUMN_GAP)));
  const rows = Math.ceil(count / fit);
  const perRow = Math.ceil(count / rows);
  return (
    <div className="board" ref={setEl} style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

const MIN_COLUMN_W = 170;
const COLUMN_GAP = 12;

/**
 * Whose name a card shows. The Planning Center person on the mic comes
 * first; the preset's nickname for the channel (e.g. "Lead Vox") is then
 * shown alongside. Without one, the nickname, then the receiver's channel
 * name, then the RF label. Photos come only with a person, not a nickname.
 */
function shownName(s: SlotView, nickname?: string): { name: string; photo?: string; aside?: string } {
  const a = s.assignment;
  if (a?.planningCenter) return { name: a.artist, photo: a.photoUrl, aside: nickname };
  if (nickname) return { name: nickname };
  return { name: a?.artist ?? s.label, photo: a?.photoUrl };
}

/** One person: photo behind, then RF label, name, battery, and their in-ear pack. */
function MicColumn({ s, nickname, iem, online }: { s: SlotView; nickname?: string; iem?: SlotView; online: boolean }) {
  const a = s.assignment;
  const r = shownReadiness(s, nickname);
  const tone = online ? READINESS_TONE[r.label] : 'idle';
  const [photoFailed, setPhotoFailed] = useState(false);
  const who = shownName(s, nickname);
  const name = who.name;
  const photo = who.photo && !photoFailed ? who.photo : undefined;
  const t = s.telemetry;
  const isIem = s.role === 'iem';

  return (
    <article className={`col col--${tone}${online && s.leading ? ' col--leading' : ''}${photo ? ' col--photo' : ''}`}>
      {photo
        ? <img className="col__photo" src={photo} alt="" onError={() => setPhotoFailed(true)} />
        : <div className="col__initials" aria-hidden="true">{initials(name)}</div>}
      <div className="col__shade" />

      <header className="col__top">
        <span className="col__label">{s.label}</span>
        <span className="col__status">{online ? r.status : 'Unknown'}</span>
      </header>
      {online && s.leading && <span className="col__leading">Leading now</span>}

      <div className="col__body">
        <div className="col__name">{name}</div>
        {a?.role && <div className="col__role">{a.role}</div>}
        <div className="col__kind">{[kindLabel(s.kind), who.aside].filter(Boolean).join(' · ')}</div>

        {online && (isIem ? <IemLine s={s} /> : <BatteryLine s={s} r={r} />)}
        {online && iem && (
          <div className="col__iem">
            <span className="col__iem-tag">IEM</span>
            <span className="col__iem-label">{iem.label}</span>
            <IemLine s={iem} compact />
          </div>
        )}
        {!online && t && <div className="col__line col__line--dim">Display not connected</div>}
        {a?.notes && <div className="col__notes">{a.notes}</div>}
      </div>
    </article>
  );
}

/** The mic's battery as bars and percent; the charge instead while it sits in its charger. */
function BatteryLine({ s, r }: { s: SlotView; r: ReturnType<typeof shownReadiness> }) {
  const t = s.telemetry;
  if (r.source === 'charger' && r.chargePercent !== undefined) {
    return <div className="col__line"><Battery bars={undefined} percent={r.chargePercent} tone={r.chargePercent < 30 ? 'warn' : 'ok'} /><span className="col__pct">{r.chargePercent}%</span><span className="col__sub">charging</span></div>;
  }
  if (!s.txOn) return <div className="col__line col__line--dim">Transmitter off</div>;
  const pct = value(t.batteryPercent);
  const bars = value(t.batteryBars);
  const low = s.alerts.some((x) => x.code === 'battery-critical' || x.code === 'battery-low');
  return (
    <div className="col__line">
      <Battery bars={bars} percent={pct} tone={low ? 'bad' : 'ok'} />
      <span className="col__pct">{pct !== undefined ? `${pct}%` : bars !== undefined ? `${bars}/5` : '–'}</span>
    </div>
  );
}

/**
 * An in-ear channel: what the rack transmitter is doing (the pack itself
 * reports nothing), plus the pack's charge when it has a charger bay.
 */
function IemLine({ s, compact = false }: { s: SlotView; compact?: boolean }) {
  const t = s.telemetry;
  const muted = value(t.rfMuted);
  const mw = value(t.rfOutputMw);
  const charge = s.bay?.chargePercent.state === 'ok' && s.bay.batteryPresent.state === 'ok' && s.bay.batteryPresent.value ? s.bay.chargePercent.value : undefined;
  return (
    <div className={`col__line${compact ? ' col__line--iem' : ''}`}>
      {muted ? <span className="col__bad">RF muted</span> : mw === 0 ? <span className="col__bad">RF off</span> : mw !== undefined ? <span>On air</span> : <span className="col__sub">–</span>}
      {charge !== undefined && <span className="col__sub">pack {charge}%</span>}
    </div>
  );
}

function ArtistCard({ s, nickname, online }: { s: SlotView; nickname?: string; online: boolean }) {
  const a = s.assignment;
  const r = shownReadiness(s, nickname);
  const tone = online ? READINESS_TONE[r.label] : 'idle';
  const [photoFailed, setPhotoFailed] = useState(false);
  const who = shownName(s, nickname);
  const name = who.name;

  let note: string | undefined;
  if (online && r.source === 'charger' && r.chargePercent !== undefined) note = `Charge ${r.chargePercent}%`;
  else if (online && r.source === 'receiver' && s.telemetry.batteryPercent.state === 'ok') note = `Battery ${s.telemetry.batteryPercent.value}%`;

  return (
    <article className={`card card--${tone}${online && s.leading ? ' card--leading' : ''}`}>
      <div className="card__status">
        {online ? <StatusPill readiness={r} size="lg" /> : <span className="pill pill--idle pill--lg">Unknown</span>}
        {online && s.leading && <span className="card__leading">Leading now</span>}
      </div>
      <div className="card__who">
        <div className="card__avatar">
          {who.photo && !photoFailed
            ? <img src={who.photo} alt="" onError={() => setPhotoFailed(true)} />
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
function useFit(key: string, fixedColumns?: number, board = false): { ref: (el: HTMLDivElement | null) => void; density: Density; columns: number } {
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
    if (!el || board) return;
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
