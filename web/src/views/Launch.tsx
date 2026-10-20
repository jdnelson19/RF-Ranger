import { useState } from 'react';
import { href } from '../route';
import type { Live } from '../useSnapshot';
import { Brand, Chip, ServerLink, UpdateLink } from '../components/ui';
import { navigate } from '../route';

function isThisComputer(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

/** Desktop app only: the server runs in the background, so this is how it stops. */
function QuitButton() {
  const [state, setState] = useState<'idle' | 'quitting' | 'failed'>('idle');
  if (state === 'quitting') return <span className="dim">RF Ranger has quit. Metering is off on every receiver.</span>;
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      onClick={() => {
        if (!window.confirm('Quit RF Ranger? Monitoring stops on every screen.')) return;
        fetch('/api/app/quit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => setState(r.ok ? 'quitting' : 'failed'), () => setState('failed'));
      }}
    >
      {state === 'failed' ? 'Quit failed. Try again' : 'Quit RF Ranger'}
    </button>
  );
}

/** The first screen every time: pick Artist Pickup or Engineer. */
export function Launch({ live }: { live: Live }) {
  const s = live.snapshot;
  const slots = s?.slots ?? [];
  const assigned = slots.filter((x) => x.assignment);
  const ready = assigned.filter((x) => x.readiness.label === 'READY').length;
  const attention = slots.filter((x) => x.alerts.some((a) => a.severity !== 'info')).length;
  const rxUp = s?.receivers.filter((r) => r.status.state === 'connected').length ?? 0;

  return (
    <main className="launch">
      <header className="launch__head">
        <Brand />
        <p className="launch__tagline">Your wireless. Under control.</p>
      </header>

      <div className="launch__choices">
        <a className="choice choice--pickup" href={href({ view: 'pickup' })}>
          <span className="choice__icon" aria-hidden="true">
            <svg viewBox="0 0 48 48"><rect x="6" y="9" width="36" height="24" rx="3" /><path d="M18 39h12M24 33v6" /><circle cx="17" cy="19" r="4" /><path d="M11 28c1.5-3 3.5-4.5 6-4.5s4.5 1.5 6 4.5M27 17h10M27 23h7" /></svg>
          </span>
          <span className="choice__title">Artist Pickup</span>
          <span className="choice__desc">Full-screen display for the RF table. Artists find their mic by name and see if it's ready.</span>
          <span className="choice__stat">{s ? `${ready} of ${assigned.length} ready` : 'Connecting…'}</span>
          <span className="choice__go">Open pickup display →</span>
        </a>

        <a className="choice choice--engineer" href={href({ view: 'engineer' })}>
          <span className="choice__icon" aria-hidden="true">
            <svg viewBox="0 0 48 48"><rect x="6" y="8" width="15" height="14" rx="2" /><rect x="27" y="8" width="15" height="14" rx="2" /><rect x="6" y="26" width="15" height="14" rx="2" /><rect x="27" y="26" width="15" height="14" rx="2" /><path d="M10 18h7M31 14h7M31 18h4M10 36h4M31 36h7" /></svg>
          </span>
          <span className="choice__title">Engineer</span>
          <span className="choice__desc">Battery, RF, audio and faults for every channel, with what needs attention first.</span>
          <span className="choice__stat">
            {s ? (
              <>
                <span className={attention ? 'warn-text' : 'ok-text'}>{attention ? `${attention} need attention` : 'No issues'}</span>
                {' · '}{rxUp}/{s.receivers.length} receivers online
              </>
            ) : 'Connecting…'}
          </span>
          <span className="choice__go">Open engineer dashboard →</span>
        </a>
      </div>

      {s && s.presets.length > 0 && (
        <div className="launch__groups">
          <span className="launch__groups-label">Pickup display for a show preset:</span>
          {s.presets.map((p) => (
            <Chip key={p.id} onClick={() => navigate({ view: 'pickup', show: p.id })}>{p.name}</Chip>
          ))}
        </div>
      )}
      {s && s.groups.length > 0 && (
        <div className="launch__groups">
          <span className="launch__groups-label">Pickup display for one group:</span>
          {s.groups.map((g) => (
            <Chip key={g} onClick={() => navigate({ view: 'pickup', group: g })}>{g}</Chip>
          ))}
        </div>
      )}

      <footer className="launch__foot">
        <ServerLink online={live.online} version={live.snapshot?.version} />
        <UpdateLink update={s?.update} />
        {s?.demo && <span className="tag tag--demo">Demo data</span>}
        <span className="dim">Tip: bookmark a view to open it directly, e.g. a TV straight into Pickup.</span>
        {s?.app && isThisComputer() && <QuitButton />}
      </footer>
    </main>
  );
}
