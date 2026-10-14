import { useMemo, useState } from 'react';
import { ChannelDetail } from '../components/ChannelDetail';
import { ChannelTile } from '../components/ChannelTile';
import { Brand, Chip, ServerLink } from '../components/ui';
import { TONE_RANK, slotTone } from '../format';
import { href, navigate, type Route } from '../route';
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
  const frozen = !live.online;

  const needsAttention = (x: NonNullable<typeof s>['slots'][number]) => x.alerts.some((a) => a.severity !== 'info');

  const slots = useMemo(() => {
    let list = s?.slots ?? [];
    if (route.group) list = list.filter((x) => x.group === route.group);
    if (route.view === 'attention') list = list.filter(needsAttention);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((x) =>
        [x.label, x.assignment?.artist, x.assignment?.role, x.receiverId, x.telemetry.name.state === 'ok' ? x.telemetry.name.value : '']
          .some((f) => f?.toLowerCase().includes(q)),
      );
    }
    if (sort === 'status' || route.view === 'attention') {
      list = [...list].sort((a, b) => TONE_RANK[slotTone(a)] - TONE_RANK[slotTone(b)] || a.slot - b.slot);
    }
    return list;
  }, [s, route.view, route.group, query, sort]);

  const attentionCount = (s?.slots ?? []).filter(needsAttention).length;
  const openSlot = s?.slots.find((x) => x.slot === open);
  const rxDown = s?.receivers.filter((r) => r.status.state !== 'connected') ?? [];

  return (
    <div className="eng">
      <header className="topbar">
        <a href={href({ view: 'launch' })} className="topbar__home" title="Back to start"><Brand compact /></a>
        <nav className="tabs" aria-label="Engineer views">
          <a className={`tab${route.view === 'engineer' ? ' tab--active' : ''}`} href={href({ view: 'engineer', group: route.group })}>All channels</a>
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
          <a className="btn btn--ghost" href={href({ view: 'pickup', group: route.group })}>Pickup view ↗</a>
          <ServerLink online={live.online} />
        </div>
      </header>

      {frozen && s && (
        <div className="frozen-banner" role="alert">No link to the RF Ranger server. Values below are frozen and may be out of date.</div>
      )}

      {route.view === 'inspector' ? (
        <Inspector live={live} />
      ) : route.view === 'planning-center' ? (
        <PlanningCenter />
      ) : route.view === 'devices' ? (
        <Devices live={live} />
      ) : (
        <>
          <div className="toolbar">
            <div className="toolbar__chips">
              <Chip active={!route.group} onClick={() => navigate({ view: route.view, group: undefined })}>All groups</Chip>
              {s?.groups.map((g) => (
                <Chip key={g} active={route.group === g} onClick={() => navigate({ view: route.view, group: g })}
                  count={(s.slots.filter((x) => x.group === g && needsAttention(x)).length) || undefined}>
                  {g}
                </Chip>
              ))}
            </div>
            <div className="toolbar__right">
              {route.view !== 'attention' && (
                <div className="seg" role="group" aria-label="Sort">
                  <button type="button" className={sort === 'slot' ? 'seg--on' : ''} onClick={() => setSort('slot')}>Slot</button>
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
          ) : slots.length === 0 ? (
            <div className="empty">{route.view === 'attention' ? <><span className="ok-text">✓</span> Nothing needs attention{route.group ? ` in ${route.group}` : ''}.</> : 'No channels match.'}</div>
          ) : (
            <div className={`grid${frozen ? ' grid--frozen' : ''}`}>
              {slots.map((x) => <ChannelTile key={x.slot} s={x} frozen={frozen} onOpen={() => setOpen(x.slot)} />)}
            </div>
          )}
        </>
      )}

      {openSlot && s && <ChannelDetail s={openSlot} now={s.serverTime} onClose={() => setOpen(undefined)} />}
    </div>
  );
}
