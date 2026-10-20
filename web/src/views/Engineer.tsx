import { useMemo, useState } from 'react';
import { ChannelDetail } from '../components/ChannelDetail';
import { ChannelTile } from '../components/ChannelTile';
import { LiveBanner } from '../components/LiveNow';
import { ShowEditor, presetApi } from '../components/ShowEditor';
import { Brand, Chip, ServerLink, UpdateLink } from '../components/ui';
import { TILE_FIELDS, useDisplayOptions } from '../display';
import { TONE_RANK, shownReadiness, slotTone } from '../format';
import { href, navigate, type Route } from '../route';
import type { ShowPreset } from '../types';
import type { Live } from '../useSnapshot';
import { Devices } from './Devices';
import { Inspector } from './Inspector';
import { PlanningCenter } from './PlanningCenter';

type Sort = 'slot' | 'status';

export function Engineer({ live, route }: { live: Live; route: Route }) {
  const s = live.snapshot;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('slot');
  const [open, setOpen] = useState<number | undefined>();
  const [editing, setEditing] = useState<{ preset?: ShowPreset } | undefined>();
  const [displayOpen, setDisplayOpen] = useState(false);
  const display = useDisplayOptions();
  const frozen = !live.online;

  // A show preset limits and orders the main grid only. Attention always
  // covers every channel, so a preset can never hide a problem.
  const presets = s?.presets ?? [];
  const activePreset = route.view === 'engineer' && route.show ? presets.find((p) => p.id === route.show) : undefined;
  const missingPreset = route.view === 'engineer' && !!route.show && !!s && !activePreset;

  const needsAttention = (x: NonNullable<typeof s>['slots'][number]) => x.alerts.some((a) => a.severity !== 'info');

  const slots = useMemo(() => {
    let list = s?.slots ?? [];
    if (activePreset) {
      const byKey = new Map(list.map((x) => [x.key, x]));
      list = activePreset.slots.map((k) => byKey.get(k)).filter((x): x is NonNullable<typeof x> => !!x);
    }
    if (route.group) list = list.filter((x) => x.group === route.group);
    if (route.view === 'attention') list = list.filter(needsAttention);
    const q = query.trim().toLowerCase();
    const nick = (x: (typeof list)[number]) => activePreset?.channels?.[x.key]?.nickname;
    if (q) {
      list = list.filter((x) =>
        [nick(x), x.label, x.assignment?.artist, x.assignment?.role, x.receiverId, x.telemetry.name.state === 'ok' ? x.telemetry.name.value : '']
          .some((f) => f?.toLowerCase().includes(q)),
      );
    }
    if (sort === 'status' || route.view === 'attention') {
      const rank = (x: (typeof list)[number]) => TONE_RANK[slotTone(x, shownReadiness(x, nick(x)))];
      list = [...list].sort((a, b) => rank(a) - rank(b) || a.slot - b.slot);
    }
    return list;
  }, [s, route.view, route.group, query, sort, activePreset]);

  // None of the preset's receivers is online: each channel is either missing
  // (its receiver hasn't been found since RF Ranger started) or offline.
  const presetOffline = useMemo(() => {
    if (!activePreset || !s) return false;
    const byKey = new Map(s.slots.map((x) => [x.key, x]));
    return activePreset.slots.every((k) => {
      const x = byKey.get(k);
      return !x || x.alerts.some((a) => a.code === 'rx-offline');
    });
  }, [s, activePreset]);

  const attentionCount = (s?.slots ?? []).filter(needsAttention).length;
  const openSlot = s?.slots.find((x) => x.slot === open);
  const rxDown = s?.receivers.filter((r) => r.status.state !== 'connected') ?? [];

  return (
    <div className="eng">
      <header className="topbar">
        <a href={href({ view: 'launch' })} className="topbar__home" title="Back to start"><Brand compact /></a>
        <nav className="tabs" aria-label="Engineer views">
          <a className={`tab${route.view === 'engineer' ? ' tab--active' : ''}`} href={href({ view: 'engineer', group: route.group, show: route.show })}>{activePreset ? activePreset.name : 'All channels'}</a>
          <a className={`tab${route.view === 'attention' ? ' tab--active' : ''}`} href={href({ view: 'attention', group: route.group })}>
            Attention {attentionCount > 0 && <span className="tab__badge">{attentionCount}</span>}
          </a>
          <a className={`tab${route.view === 'devices' ? ' tab--active' : ''}`} href={href({ view: 'devices' })}>
            Devices {rxDown.length > 0 && <span className="tab__badge tab__badge--bad">{rxDown.length}</span>}
          </a>
          <a className={`tab${route.view === 'inspector' ? ' tab--active' : ''}`} href={href({ view: 'inspector' })}>Inspector</a>
          <a className={`tab${route.view === 'planning-center' ? ' tab--active' : ''}`} href={href({ view: 'planning-center' })}>Planning Center</a>
        </nav>
        <div className="topbar__right">
          <a className="btn btn--ghost" href={href({ view: 'pickup' })} title="Opens the pickup display, showing the preset assigned to it">Pickup view ↗</a>
          <UpdateLink update={s?.update} />
          <ServerLink online={live.online} version={live.snapshot?.version} />
        </div>
      </header>

      <LiveBanner live={live} />

      {frozen && s && (
        <div className="frozen-banner" role="alert">No link to the RF Ranger server. Values below are frozen and may be out of date.</div>
      )}

      {route.view === 'inspector' ? (
        <Inspector live={live} />
      ) : route.view === 'planning-center' ? (
        <PlanningCenter slots={s?.slots ?? []} />
      ) : route.view === 'devices' ? (
        <Devices live={live} />
      ) : (
        <>
          {route.view === 'engineer' && (
            <div className="showbar">
              <label className="showbar__pick">
                <span className="showbar__label">Show</span>
                <select
                  className="input input--sm"
                  value={activePreset?.id ?? ''}
                  onChange={(e) => navigate({ view: 'engineer', group: route.group, show: e.target.value || undefined })}
                >
                  <option value="">All channels</option>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.slots.length})</option>)}
                </select>
              </label>
              {activePreset && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing({ preset: activePreset })}>Edit preset</button>}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing({})} disabled={!s}>New preset</button>
              <label className="showbar__pick showbar__pickup" title="What the pickup display shows. TVs bookmarked to one preset stay on it.">
                <span className="showbar__label">Pickup display</span>
                <select
                  className="input input--sm"
                  value={s?.pickupPreset ?? ''}
                  disabled={!s}
                  onChange={(e) => void presetApi('/pickup', { id: e.target.value || null }).catch((err: Error) => window.alert(err.message))}
                >
                  <option value="">All channels</option>
                  {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <div className="showbar__display">
                <button type="button" className="btn btn--ghost btn--sm" aria-expanded={displayOpen} onClick={() => setDisplayOpen((o) => !o)}>
                  Display ▾
                </button>
                {displayOpen && (
                  <>
                    <div className="popover-backdrop" onClick={() => setDisplayOpen(false)} />
                    <div className="popover" role="menu" aria-label="Tile details">
                      <div className="popover__title">Show on every mic tile</div>
                      {TILE_FIELDS.map((f) => (
                        <label key={f.id} className="popover__item">
                          <input type="checkbox" checked={display.options[f.id]} onChange={() => display.toggle(f.id)} />
                          <span>{f.label}<span className="dim"> · {f.hint}</span></span>
                        </label>
                      ))}
                      <div className="popover__foot">
                        <span className="dim">Saved for this screen only.</span>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={display.reset}>Show all</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {missingPreset && (
            <div className="notice">That show preset was deleted. <a className="link" href={href({ view: 'engineer', group: route.group })}>Show all channels</a></div>
          )}
          {/* While the link to the server is down, the frozen banner already says so. */}
          {presetOffline && !frozen && activePreset && (
            <div className="notice notice--offline" role="status">
              <b>No receivers online for this preset.</b> The receivers for its {activePreset.slots.length === 1 ? 'channel are' : `${activePreset.slots.length} channels are`} switched
              off, unplugged, or not on this network. Channels come back here as soon as their receiver does.{' '}
              <a className="link" href={href({ view: 'devices' })}>Devices</a>
            </div>
          )}

          <div className="toolbar">
            <div className="toolbar__chips">
              <Chip active={!route.group} onClick={() => navigate({ view: route.view, group: undefined, show: route.show })}>All groups</Chip>
              {s?.groups.map((g) => (
                <Chip key={g} active={route.group === g} onClick={() => navigate({ view: route.view, group: g, show: route.show })}
                  count={(s.slots.filter((x) => x.group === g && needsAttention(x)).length) || undefined}>
                  {g}
                </Chip>
              ))}
            </div>
            <div className="toolbar__right">
              {route.view !== 'attention' && (
                <div className="seg" role="group" aria-label="Sort">
                  <button type="button" className={sort === 'slot' ? 'seg--on' : ''} onClick={() => setSort('slot')}>{activePreset ? 'Preset order' : 'Slot'}</button>
                  <button type="button" className={sort === 'status' ? 'seg--on' : ''} onClick={() => setSort('status')}>Status</button>
                </div>
              )}
              <input className="search" type="search" placeholder="Search name, slot, receiver…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          {!s ? (
            <div className="empty">Connecting to RF Ranger…</div>
          ) : s.slots.length === 0 && s.mode === 'live' ? (
            <div className="empty">
              <div className="empty__title">Looking for Shure receivers…</div>
              <p>Devices appear here as they're found. Progress is on the <a className="link" href={href({ view: 'devices' })}>Devices</a> tab.</p>
              <p className="dim">Nothing showing up? Make sure this computer is on the receivers' network, or restart with <code>npm run live -- --receiver &lt;ip&gt;</code>.</p>
            </div>
          ) : slots.length === 0 && presetOffline && !query && !route.group ? (
            <div className="empty">
              <div className="empty__title">No receivers online</div>
              <p>Waiting for the receivers in “{activePreset?.name}”. Switch them on, or check they're on this network.</p>
            </div>
          ) : slots.length === 0 ? (
            <div className="empty">{route.view === 'attention' ? <><span className="ok-text">✓</span> Nothing needs attention{route.group ? ` in ${route.group}` : ''}.</> : 'No channels match.'}</div>
          ) : (
            <div className={`grid${frozen ? ' grid--frozen' : ''}`}>
              {slots.map((x) => (
                <ChannelTile key={x.key} s={x} frozen={frozen} fields={display.options} preset={activePreset?.channels?.[x.key]} onOpen={() => setOpen(x.slot)} />
              ))}
            </div>
          )}
        </>
      )}

      {editing && s && (
        <ShowEditor
          slots={s.slots}
          groups={s.groups}
          preset={editing.preset}
          onClose={() => setEditing(undefined)}
          onSaved={(id) => {
            setEditing(undefined);
            navigate({ view: 'engineer', group: route.group, show: id });
          }}
        />
      )}

      {openSlot && s && (
        <ChannelDetail s={openSlot} now={s.serverTime} live={!frozen} nickname={activePreset?.channels?.[openSlot.key]?.nickname} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}
