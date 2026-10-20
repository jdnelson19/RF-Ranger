import { useEffect, useMemo, useState } from 'react';
import type { AutoSyncInfo, AutoSyncRule, MicRules, RoleRule, Roster, ServiceSetup, ServiceType, SlotView, Team, TeamPerson, UpcomingSummary } from '../types';

type MicData = { services: ServiceSetup[]; roster: Roster; auto: Record<string, AutoSyncInfo> };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/pco${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const LEADS: Array<[minutes: number, label: string]> = [
  [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'],
  [240, '4 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '1 day'],
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const when = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Mics from Planning Center. Each service (a Planning Center service type,
 * e.g. a weekend service, a youth night and a midweek service) has its own
 * mic rules and its own sync: by hand, a set time before its next rehearsal
 * or service, or at a fixed time every week. A sync changes only that
 * service's mics; any mic can then be changed by hand.
 */
export function MicAssignments({ slots, types }: { slots: SlotView[]; types: ServiceType[] }) {
  const [data, setData] = useState<MicData | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MicData>('/mics').then(setData, (e: Error) => setError(e.message));
  }, []);

  const run = async (fn: () => Promise<MicData>) => {
    setBusy(true);
    setError(undefined);
    try {
      setData(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mics = useMemo(() => slots.filter((s) => s.role === 'mic').sort((a, b) => a.slot - b.slot), [slots]);
  const byKey = useMemo(() => new Map(mics.map((s) => [s.key, s])), [mics]);
  const label = (key: string) => byKey.get(key)?.label ?? key;

  if (!data) return <section className="pco__card"><h2 className="section-title">Mic assignments</h2><p className="dim">{error ?? 'Loading…'}</p></section>;

  const unused = types.filter((t) => !data.services.some((s) => s.serviceTypeId === t.id));
  return (
    <>
      <section className="pco__card">
        <h2 className="section-title">Services</h2>
        <p className="pco__note">
          Each Planning Center service you fill mics from, with its own rules and sync time. A sync changes only that service's
          mics, so a multipurpose room can switch between services through the week.
        </p>
        {data.services.length === 0 && <p className="dim">Add the first service below.</p>}
        {data.services.map((s) => (
          <ServicePanel
            key={s.id}
            service={s}
            roster={data.roster}
            auto={data.auto[s.id]}
            mics={mics}
            label={label}
            busy={busy}
            run={run}
          />
        ))}
        <AddService types={unused} busy={busy} onAdd={(id) => void run(() => api<MicData>('/mics/services/add', { serviceTypeId: id }))} />
        {error && <p className="pco__error" role="alert">{error}</p>}
      </section>

      <MicsNow data={data} mics={mics} byKey={byKey} label={label} busy={busy} run={run} />
    </>
  );
}

function AddService({ types, busy, onAdd }: { types: ServiceType[]; busy: boolean; onAdd: (id: string) => void }) {
  const [id, setId] = useState('');
  if (!types.length) return null;
  return (
    <div className="mics__add">
      <select className="input input--sm" value={id} onChange={(e) => setId(e.target.value)} disabled={busy}>
        <option value="">Add a service…</option>
        {[...types].sort((a, b) => a.name.localeCompare(b.name)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !id} onClick={() => { onAdd(id); setId(''); }}>Add</button>
    </div>
  );
}

function ServicePanel({ service, roster, auto, mics, label, busy, run }: {
  service: ServiceSetup;
  roster: Roster;
  auto: AutoSyncInfo | undefined;
  mics: SlotView[];
  label: (key: string) => string;
  busy: boolean;
  run: (fn: () => Promise<MicData>) => Promise<void>;
}) {
  const synced = roster.synced[service.id];
  const [upcoming, setUpcoming] = useState<UpcomingSummary | undefined>();
  const [open, setOpen] = useState(service.rules.teamIds.length === 0);
  useEffect(() => {
    api<UpcomingSummary>(`/upcoming?type=${encodeURIComponent(service.serviceTypeId)}`).then(setUpcoming, () => setUpcoming(undefined));
  }, [service.serviceTypeId, synced?.syncedAt]);

  const edited = Object.values(roster.entries).some((e) => e.serviceId === service.id && e.source === 'manual');
  const p = upcoming?.plan;
  return (
    <div className="svc">
      <div className="svc__head">
        <span className="svc__name">{service.name}</span>
        <span className="mics__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy || !service.rules.teamIds.length}
            title={service.rules.teamIds.length ? undefined : 'Choose the teams that get mics first (Mic rules)'}
            onClick={() => {
              if (edited && !window.confirm(`Sync ${service.name}? Changes made by hand to its mics are replaced.`)) return;
              void run(() => api<MicData>('/mics/sync', { serviceId: service.id }));
            }}
          >
            Sync now
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
            onClick={() => window.confirm(`Stop filling mics from ${service.name}? Its rules are deleted; mics it filled stay until changed.`)
              && void run(() => api<MicData>('/mics/services/remove', { serviceId: service.id }))}>
            Remove
          </button>
        </span>
      </div>

      <div className="svc__facts dim">
        <span>Next: {upcoming === undefined ? '…' : p ? <><b>{p.dates}</b>{p.title ? ` · ${p.title}` : ''} · {upcoming.scheduled} scheduled</> : 'no upcoming plan'}</span>
        {synced && <span>Last synced {when(synced.syncedAt)} for {synced.plan.dates}{synced.automatic ? ' (automatically)' : ''}</span>}
      </div>

      <AutoSyncControl service={service} auto={auto} busy={busy} run={run} />

      {synced && synced.unplaced.length > 0 && <Unplaced list={synced.unplaced} />}

      <details className="svc__rules" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Mic rules{service.rules.teamIds.length ? '' : ' (set up first)'}</summary>
        {open && (
          <Rules
            serviceTypeId={service.serviceTypeId}
            rules={service.rules}
            mics={mics}
            scheduled={synced?.people ?? []}
            label={label}
            busy={busy}
            setRules={(r) => void run(() => api<MicData>('/mics/rules', { serviceId: service.id, rules: r }))}
          />
        )}
      </details>
    </div>
  );
}

function AutoSyncControl({ service, auto, busy, run }: {
  service: ServiceSetup;
  auto: AutoSyncInfo | undefined;
  busy: boolean;
  run: (fn: () => Promise<MicData>) => Promise<void>;
}) {
  const rule = service.autoSync;
  const save = (next: AutoSyncRule | null) =>
    void run(() => api<MicData>('/mics/auto', next ? { serviceId: service.id, rule: next } : { serviceId: service.id, off: true }));
  const disabled = busy || !service.rules.teamIds.length;

  return (
    <div className="mics__auto">
      <label>
        <span>Auto-sync</span>
        <select
          className="input input--sm"
          value={rule?.kind ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const kind = e.target.value;
            save(kind === 'before' ? { kind: 'before', leadMinutes: 120 } : kind === 'weekly' ? { kind: 'weekly', day: 0, time: '07:00' } : null);
          }}
        >
          <option value="">Off</option>
          <option value="before">Before the next rehearsal or service</option>
          <option value="weekly">Every week at a set time</option>
        </select>
      </label>
      {rule?.kind === 'before' && (
        <label>
          <select className="input input--sm" value={rule.leadMinutes} disabled={disabled}
            onChange={(e) => save({ kind: 'before', leadMinutes: Number(e.target.value) })}>
            {LEADS.map(([m, l]) => <option key={m} value={m}>{l} before</option>)}
          </select>
          <span>the first rehearsal or service of its next plan</span>
        </label>
      )}
      {rule?.kind === 'weekly' && (
        <label>
          <span>Every</span>
          <select className="input input--sm" value={rule.day} disabled={disabled}
            onChange={(e) => save({ ...rule, day: Number(e.target.value) })}>
            {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
          <span>at</span>
          <input className="input input--sm" type="time" value={rule.time} disabled={disabled}
            onChange={(e) => e.target.value && save({ ...rule, time: e.target.value })} />
        </label>
      )}
      <span className="dim mics__auto-status">
        {!rule ? 'Sync by hand with Sync now.'
          : auto?.error ? <span className="pco__error">{auto.error}</span>
          : auto?.next ? <>Next: <b>{when(auto.next.at)}</b>{auto.next.planDates ? ` for ${auto.next.planDates}` : ''}. Changes made after a sync stay until the next one.</>
          : auto?.done ? <>{auto.done.planDates} is synced and won't sync again on its own.</>
          : 'Checking Planning Center…'}
      </span>
    </div>
  );
}

function Unplaced({ list }: { list: Roster['synced'][string]['unplaced'] }) {
  return (
    <ul className="mics__unplaced">
      {list.map((u) => (
        <li key={u.personId} className={u.reason === 'no-mics' ? 'dim' : 'mics__unplaced--warn'}>
          No mic: <b>{u.name}</b>{u.role && ` (${u.role})`}.{' '}
          {u.reason === 'full' ? 'Every mic for this role is taken.' : u.reason === 'removed' ? 'Taken off their mic by hand.' : 'This role has no mics in the rules.'}
        </li>
      ))}
    </ul>
  );
}

function MicsNow({ data, mics, byKey, label, busy, run }: {
  data: MicData;
  mics: SlotView[];
  byKey: Map<string, SlotView>;
  label: (key: string) => string;
  busy: boolean;
  run: (fn: () => Promise<MicData>) => Promise<void>;
}) {
  const [showAll, setShowAll] = useState(false);
  const { roster, services } = data;
  const ruleMics = new Set(services.flatMap((s) => s.rules.roles.flatMap((r) => r.mics)));
  const serviceName = (id: string | undefined) => services.find((s) => s.id === id)?.name;
  const rows = showAll ? mics.map((s) => s.key) : [
    ...mics.map((s) => s.key).filter((k) => ruleMics.has(k) || k in roster.entries),
    ...Object.keys(roster.entries).filter((k) => !byKey.has(k)),
  ];

  return (
    <section className="pco__card">
      <div className="mics__head">
        <h2 className="section-title">Mics now</h2>
        <span className="dim">Shown on the engineer tiles and the pickup screen</span>
        {Object.keys(roster.entries).length > 0 && (
          <span className="mics__actions">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
              onClick={() => window.confirm('Take everyone off their mics? Services and rules stay.') && void run(() => api<MicData>('/mics/clear', {}))}>
              Clear all
            </button>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="dim">Give a service's positions their mics, then sync it.</p>
      ) : (
        <table className="mics__table">
          <thead><tr><th>Mic</th><th>Person</th><th>Role</th><th>From</th><th /></tr></thead>
          <tbody>
            {rows.map((key) => {
              const e = roster.entries[key];
              const s = byKey.get(key);
              return (
                <tr key={key}>
                  <td>
                    <span className="mics__label">{label(key)}</span>
                    <span className="dim mics__where">{s ? `${s.receiverId} ch${s.channel}` : 'not connected'}</span>
                  </td>
                  <td>
                    <PersonPicker roster={roster} value={e} disabled={busy}
                      onPick={(choice) => void run(() => api<MicData>('/mics/assign', { mic: key, ...choice }))} />
                  </td>
                  <td className="dim">{e?.role ?? ''}</td>
                  <td className="dim">{e ? serviceName(e.serviceId) ?? 'by hand' : ''}</td>
                  <td className="mics__tags">
                    {e?.unconfirmed && <span className="tag tag--warn" title="Hasn't accepted in Planning Center yet">unconfirmed</span>}
                    {e?.source === 'manual' && <span className="tag" title="Changed by hand since the last sync">edited</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <label className="mics__all"><input type="checkbox" checked={showAll} onChange={(ev) => setShowAll(ev.target.checked)} /> Show every mic</label>
    </section>
  );
}

type Choice = { personId: string } | { name: string } | { clear: true };

function PersonPicker({ roster, value, disabled, onPick }: {
  roster: Roster;
  value: Roster['entries'][string] | undefined;
  disabled: boolean;
  onPick: (c: Choice) => void;
}) {
  // Everyone from every service's last sync, grouped by role.
  const people = useMemo(() => {
    const seen = new Map<string, Roster['synced'][string]['people'][number]>();
    for (const s of Object.values(roster.synced)) for (const p of s.people) if (!seen.has(p.personId)) seen.set(p.personId, p);
    return [...seen.values()];
  }, [roster.synced]);
  const byRole = useMemo(() => {
    const groups = new Map<string, typeof people>();
    for (const p of people) groups.set(p.position || 'Other', [...(groups.get(p.position || 'Other') ?? []), p]);
    return [...groups];
  }, [people]);
  const current = value ? (value.personId && people.some((p) => p.personId === value.personId) ? value.personId : '__typed') : '';

  return (
    <select
      className="input input--sm mics__pick"
      value={current}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '') onPick({ clear: true });
        else if (v === '__other') {
          const name = window.prompt('Who is on this mic?')?.trim();
          if (name) onPick({ name });
        } else if (v !== '__typed') onPick({ personId: v });
      }}
    >
      <option value="">Nobody</option>
      {current === '__typed' && <option value="__typed">{value!.name}</option>}
      {byRole.map(([role, list]) => (
        <optgroup key={role} label={role}>
          {list.map((p) => <option key={p.personId} value={p.personId}>{p.name}{p.status === 'unconfirmed' ? ' (unconfirmed)' : ''}</option>)}
        </optgroup>
      ))}
      <option value="__other">Someone else…</option>
    </select>
  );
}

function Rules({ serviceTypeId, rules, mics, scheduled, label, busy, setRules }: {
  serviceTypeId: string;
  rules: MicRules;
  mics: SlotView[];
  /** People from this service's last sync: staff can be scheduled on a team without being listed as its members. */
  scheduled: Roster['synced'][string]['people'];
  label: (key: string) => string;
  busy: boolean;
  setRules: (r: MicRules) => void;
}) {
  const [teams, setTeams] = useState<Team[] | undefined>();
  const [teamsError, setTeamsError] = useState<string | undefined>();
  const [people, setPeople] = useState<Record<string, TeamPerson[]>>({});

  useEffect(() => {
    api<{ teams: Team[] }>(`/teams?type=${encodeURIComponent(serviceTypeId)}`).then((r) => setTeams(r.teams), (e: Error) => setTeamsError(e.message));
  }, [serviceTypeId]);

  const chosen = (teams ?? []).filter((t) => rules.teamIds.includes(t.id));
  useEffect(() => {
    for (const t of chosen) {
      if (people[t.id]) continue;
      api<{ people: TeamPerson[] }>(`/team-people?team=${encodeURIComponent(t.id)}`)
        .then((r) => setPeople((p) => ({ ...p, [t.id]: r.people })), () => setPeople((p) => ({ ...p, [t.id]: [] })));
    }
  }, [chosen.map((t) => t.id).join(',')]);

  const peopleFor = (teamId: string): TeamPerson[] | undefined => {
    const members = people[teamId];
    if (!members) return undefined;
    const extra = scheduled
      .filter((p) => p.teamId === teamId && !members.some((m) => m.id === p.personId))
      .map((p) => ({ id: p.personId, name: p.name, photoUrl: p.photoUrl }));
    return [...members, ...extra].sort((a, b) => a.name.localeCompare(b.name));
  };
  const ruleFor = (teamId: string, position: string): RoleRule =>
    rules.roles.find((r) => r.teamId === teamId && same(r.position, position)) ?? { teamId, position, mics: [], prefer: [] };
  const putRule = (next: RoleRule) => setRules({
    ...rules,
    roles: [...rules.roles.filter((r) => !(r.teamId === next.teamId && same(r.position, next.position))), next],
  });

  return (
    <div className="mics__rules">
      <p className="pco__note">
        Choose the teams that use wireless, then give each position its mics, in the order to fill them. A preferred mic puts
        that person on it whenever they're scheduled in that position.
      </p>
      {teamsError ? <p className="pco__error">{teamsError}</p> : !teams ? <p className="dim">Loading teams…</p> : (
        <div className="mics__teams" role="group" aria-label="Teams that get mics">
          {teams.filter((t) => t.positions.length).map((t) => {
            const on = rules.teamIds.includes(t.id);
            return (
              <button key={t.id} type="button" className={`chip${on ? ' chip--active' : ''}`} aria-pressed={on} disabled={busy}
                onClick={() => setRules({ ...rules, teamIds: on ? rules.teamIds.filter((x) => x !== t.id) : [...rules.teamIds, t.id] })}>
                {t.name}
              </button>
            );
          })}
        </div>
      )}

      {chosen.map((t) => (
        <div key={t.id} className="mics__team">
          <h3>{t.name}</h3>
          {t.positions.map((position) => {
            const rule = ruleFor(t.id, position);
            return (
              <div key={position} className="mics__role">
                <div className="mics__role-name">{position}</div>
                <div className="mics__chips">
                  {mics.length === 0 && <span className="dim">No mics found yet.</span>}
                  {mics.map((s) => {
                    const at = rule.mics.indexOf(s.key);
                    return (
                      <button key={s.key} type="button" disabled={busy} aria-pressed={at >= 0}
                        className={`micpick${at >= 0 ? ' micpick--on' : ''}`}
                        title={at >= 0 ? `Filled ${ordinal(at + 1)}. Click to remove.` : `Use ${s.label} for ${position}`}
                        onClick={() => putRule({
                          ...rule,
                          mics: at >= 0 ? rule.mics.filter((k) => k !== s.key) : [...rule.mics, s.key],
                          prefer: at >= 0 ? rule.prefer.filter((p) => p.mic !== s.key) : rule.prefer,
                        })}>
                        {at >= 0 && <span className="micpick__n">{at + 1}</span>}{s.label}
                      </button>
                    );
                  })}
                </div>
                {rule.mics.length > 0 && (
                  <Preferences rule={rule} people={peopleFor(t.id)} label={label} busy={busy} onChange={putRule} />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Preferences({ rule, people, label, busy, onChange }: {
  rule: RoleRule;
  people: TeamPerson[] | undefined;
  label: (key: string) => string;
  busy: boolean;
  onChange: (r: RoleRule) => void;
}) {
  const [personId, setPersonId] = useState('');
  const [mic, setMic] = useState('');
  const free = rule.mics.filter((m) => !rule.prefer.some((p) => p.mic === m));
  const choosable = (people ?? []).filter((p) => !rule.prefer.some((x) => x.personId === p.id));

  return (
    <div className="mics__prefs">
      {rule.prefer.map((p) => (
        <span key={p.personId} className="mics__pref">
          {p.name} prefers <b>{label(p.mic)}</b>
          <button type="button" className="icon-btn" aria-label={`Remove ${p.name}'s preferred mic`} disabled={busy}
            onClick={() => onChange({ ...rule, prefer: rule.prefer.filter((x) => x.personId !== p.personId) })}>✕</button>
        </span>
      ))}
      {free.length > 0 && (
        <span className="mics__pref-add">
          <select className="input input--sm" value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={busy || !people}>
            <option value="">{people ? 'Preferred mic for…' : 'Loading people…'}</option>
            {choosable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input input--sm" value={mic} onChange={(e) => setMic(e.target.value)} disabled={busy}>
            <option value="">Mic…</option>
            {free.map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </select>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !personId || !mic}
            onClick={() => {
              const p = people!.find((x) => x.id === personId)!;
              onChange({ ...rule, prefer: [...rule.prefer, { personId, name: p.name, mic }] });
              setPersonId('');
              setMic('');
            }}>
            Add
          </button>
        </span>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  return n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;
}
