import { useEffect, useMemo, useState } from 'react';
import type { MicRules, RoleRule, Roster, SlotView, Team, TeamPerson } from '../types';

type MicData = { rules: MicRules; roster: Roster };

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

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Who's on which mic this service. "Sync from Planning Center" applies the
 * mic rules to the upcoming plan; any mic can then be changed by hand. The
 * rules (which teams get mics, each position's mics, preferred mics) are set
 * up once, below the table.
 */
export function MicAssignments({ slots }: { slots: SlotView[] }) {
  const [data, setData] = useState<MicData | undefined>();
  const [teams, setTeams] = useState<Team[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api<MicData>('/mics').then(setData, (e: Error) => setError(e.message));
    api<{ teams: Team[] }>('/teams').then((r) => setTeams(r.teams), (e: Error) => setError(e.message));
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

  const { rules, roster } = data;
  const ruleMics = new Set(rules.roles.flatMap((r) => r.mics));
  const edited = Object.values(roster.entries).some((e) => e.source === 'manual');
  // Rows: mics the rules use or someone is on; every mic on request.
  const rows = showAll ? mics.map((s) => s.key) : [
    ...mics.map((s) => s.key).filter((k) => ruleMics.has(k) || k in roster.entries),
    ...Object.keys(roster.entries).filter((k) => !byKey.has(k)),
  ];
  const setRules = (next: MicRules) => run(() => api<MicData>('/mics/rules', { rules: next }));

  return (
    <>
      <section className="pco__card">
        <div className="mics__head">
          <h2 className="section-title">Mic assignments</h2>
          <span className="dim">
            {roster.plan ? `${roster.plan.dates}${roster.plan.title ? ` · ${roster.plan.title}` : ''}` : 'Not synced yet'}
            {roster.syncedAt && ` · synced ${new Date(roster.syncedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`}
          </span>
          <span className="mics__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy || !rules.teamIds.length}
              title={rules.teamIds.length ? undefined : 'Choose the teams that get mics first (below)'}
              onClick={() => {
                if (edited && !window.confirm('Sync from Planning Center? Changes you made by hand are replaced.')) return;
                void run(() => api<MicData>('/mics/sync', {}));
              }}
            >
              {busy ? 'Working…' : 'Sync from Planning Center'}
            </button>
            {Object.keys(roster.entries).length > 0 && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy}
                onClick={() => window.confirm('Take everyone off their mics? The rules stay.') && void run(() => api<MicData>('/mics/clear', {}))}>
                Clear
              </button>
            )}
          </span>
        </div>
        <p className="pco__note">
          Sync fills the mics from the next service using the rules below. Change any mic afterwards; names, roles and photos
          show on the engineer tiles and the pickup screen. Syncing again replaces changes made by hand.
        </p>

        {rows.length === 0 ? (
          <p className="dim">{rules.teamIds.length ? 'Give positions their mics below, then sync.' : 'Set up the mic rules below, then sync.'}</p>
        ) : (
          <table className="mics__table">
            <thead><tr><th>Mic</th><th>Person</th><th>Role</th><th /></tr></thead>
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
                      <PersonPicker
                        roster={roster}
                        value={e}
                        disabled={busy}
                        onPick={(choice) => void run(() => api<MicData>('/mics/assign', { mic: key, ...choice }))}
                      />
                    </td>
                    <td className="dim">{e?.role ?? ''}</td>
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
        <label className="mics__all"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show every mic</label>

        {roster.unplaced.length > 0 && (
          <ul className="mics__unplaced">
            {roster.unplaced.map((u) => (
              <li key={u.personId} className={u.reason === 'no-mics' ? 'dim' : 'mics__unplaced--warn'}>
                No mic: <b>{u.name}</b>{u.role && ` (${u.role})`}.{' '}
                {u.reason === 'full' ? 'Every mic for this role is taken.' : u.reason === 'removed' ? 'Taken off their mic by hand.' : 'This role has no mics in the rules.'}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="pco__error" role="alert">{error}</p>}
      </section>

      <Rules rules={rules} teams={teams} mics={mics} scheduled={roster.people} label={label} busy={busy} setRules={(r) => void setRules(r)} />
    </>
  );
}

type Choice = { personId: string } | { name: string } | { clear: true };

function PersonPicker({ roster, value, disabled, onPick }: {
  roster: Roster;
  value: Roster['entries'][string] | undefined;
  disabled: boolean;
  onPick: (c: Choice) => void;
}) {
  const byRole = useMemo(() => {
    const groups = new Map<string, Roster['people']>();
    for (const p of roster.people) groups.set(p.position || 'Other', [...(groups.get(p.position || 'Other') ?? []), p]);
    return [...groups];
  }, [roster.people]);
  const current = value ? (value.personId && roster.people.some((p) => p.personId === value.personId) ? value.personId : '__typed') : '';

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
      {byRole.map(([role, people]) => (
        <optgroup key={role} label={role}>
          {people.map((p) => <option key={p.personId} value={p.personId}>{p.name}{p.status === 'unconfirmed' ? ' (unconfirmed)' : ''}</option>)}
        </optgroup>
      ))}
      <option value="__other">Someone else…</option>
    </select>
  );
}

function Rules({ rules, teams, mics, scheduled, label, busy, setRules }: {
  rules: MicRules;
  teams: Team[] | undefined;
  mics: SlotView[];
  /** People from the last sync: staff can be scheduled on a team without being listed as its members. */
  scheduled: Roster['people'];
  label: (key: string) => string;
  busy: boolean;
  setRules: (r: MicRules) => void;
}) {
  const [people, setPeople] = useState<Record<string, TeamPerson[]>>({});
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
    <section className="pco__card">
      <h2 className="section-title">Mic rules</h2>
      <p className="pco__note">
        Set up once. Choose the teams that use wireless, then give each position its mics, in the order to fill them. A
        preferred mic puts that person on it whenever they're scheduled in that position.
      </p>
      {!teams ? <p className="dim">Loading teams…</p> : (
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
    </section>
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
