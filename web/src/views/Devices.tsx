import { useState, type FormEvent } from 'react';
import { AdminSignIn, useAdmin } from '../components/ui';
import type { ConnectionStatus } from '../types';
import type { Live } from '../useSnapshot';

function Status({ s, now }: { s: ConnectionStatus; now: number }) {
  const since = Math.max(0, Math.round((now - s.since) / 1000));
  const heard = s.lastMessageAt !== undefined ? Math.max(0, Math.round((now - s.lastMessageAt) / 1000)) : undefined;
  return (
    <>
      <td><span className={`conn conn--${s.state}`}><span className="conn__dot" />{s.state}</span></td>
      <td className="num">{duration(since)}</td>
      <td className="num">{s.state === 'connected' && heard !== undefined ? `${heard}s ago` : '—'}</td>
      <td className="dim">{s.state !== 'connected' ? s.lastError ?? '' : ''}</td>
    </>
  );
}

function duration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const FOUND_TEXT = {
  identifying: 'Identifying…',
  monitoring: 'Monitoring',
  unsupported: 'Not supported',
  unreachable: 'No answer',
} as const;

/** Adding and forgetting change what is monitored, so like the Inspector they need this computer or an admin sign-in. */

async function forget(host: string): Promise<void> {
  if (!window.confirm(`Forget ${host}? RF Ranger stops monitoring it and won't remember it at the next start. Its channels leave every screen.`)) return;
  const res = await fetch('/api/devices/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host }) });
  if (!res.ok) window.alert(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Couldn't forget ${host}.`);
}

/**
 * Add a device by address, for networks where discovery can't see it (other
 * subnets, mDNS blocked). Same forms as --receiver: "10.0.1.40",
 * "ewdx@10.0.1.40", "10.0.1.40:2202". This computer only, like Forget.
 */
function AddDevice() {
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;
    setError(undefined);
    const res = await fetch('/api/devices/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
    if (res.ok) setAddress('');
    else setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not add that device.');
  };
  return (
    <form className="add-device" onSubmit={submit}>
      <input className="input" placeholder="IP address, e.g. 10.0.1.40" value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Device address"
        title="An IP address finds Shure (ports 2202, 2201) and Sennheiser (port 45) devices. To say what it is: ewdx@10.0.1.40, d6000@10.0.1.41, axd@10.0.1.20" />
      <button type="submit" className="btn btn--ghost">Add device</button>
      {error && <span className="add-device__error">{error}</span>}
    </form>
  );
}

/** Network and integration status for every configured device. */
export function Devices({ live }: { live: Live }) {
  const admin = useAdmin();
  const local = admin.state?.local === true || admin.state?.signedIn === true;
  const s = live.snapshot;
  if (!s) return <div className="empty">Connecting to RF Ranger…</div>;
  const now = s.serverTime;

  return (
    <div className="devices">
      {s.mode === 'live' && (
        <section>
          <h2 className="section-title">Found on the network</h2>
          {local ? <AddDevice /> : admin.state?.passwordSet && (
            <div className="add-device"><span className="dim">Sign in as admin to add or forget devices:</span><AdminSignIn compact title="" onSignedIn={admin.refresh} /></div>
          )}
          {s.discovered.length === 0 ? (
            <p className="dim">
              Listening for Shure and Sennheiser devices… They announce themselves every so often, so this can take a minute. If nothing
              appears, check this computer is on the same network as the receivers, or add one by its IP address. Sennheiser EW-DX
              receivers also need third-party access turned on in Sennheiser Control Cockpit (Access → 3rd party media control access → Legacy).
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Address</th><th>Model</th><th>Name</th><th>Type</th><th>Found by</th><th>Status</th><th>Note</th>{local && <th />}</tr>
              </thead>
              <tbody>
                {s.discovered.map((d) => (
                  <tr key={d.host}>
                    <td className="num strong">{d.host}</td>
                    <td>{d.model ?? <span className="dim">—</span>}</td>
                    <td>{d.deviceId ?? <span className="dim">—</span>}</td>
                    <td>{d.kind ? d.kind.toUpperCase() : <span className="dim">—</span>}</td>
                    <td className="dim">{d.source === 'manual' ? 'Address given' : d.source === 'remembered' ? 'Remembered' : 'Discovery'}</td>
                    <td><span className={`found found--${d.state}`}>{FOUND_TEXT[d.state]}</span></td>
                    <td className="dim">{d.note ?? ''}</td>
                    {local && (
                      <td>
                        {d.state === 'monitoring' && (
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void forget(d.host)}
                            title="Stop monitoring this device and stop remembering it. It comes back if it's found on the network again.">
                            Forget
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section>
        <h2 className="section-title">Receivers</h2>
        <table className="table">
          <thead>
            <tr><th>ID</th><th>Family</th><th>Model</th><th>Address</th><th>Firmware</th><th>Ch</th><th>Status</th><th>For</th><th>Last data</th><th>Error</th></tr>
          </thead>
          <tbody>
            {s.receivers.map((r) => (
              <tr key={r.info.id}>
                <td className="strong">{r.info.id}</td>
                <td>{r.info.family.toUpperCase()}</td>
                <td>{r.info.model ?? <span className="dim">—</span>}</td>
                <td className="num">{r.info.host}</td>
                <td className="num">{r.info.firmware ?? <span className="dim">—</span>}</td>
                <td className="num">{r.info.channelCount}</td>
                <Status s={r.status} now={now} />
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="section-title">Chargers</h2>
        {s.chargers.length === 0 ? (
          <p className="dim">{s.mode === 'live' ? 'No networked chargers found.' : 'No chargers configured.'}</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>ID</th><th>Model</th><th>Address</th><th>Bays</th><th>Mode</th><th>Status</th><th>For</th><th>Last data</th><th>Error</th></tr>
            </thead>
            <tbody>
              {s.chargers.map((c) => (
                <tr key={c.info.id}>
                  <td className="strong">{c.info.id}</td>
                  <td>{c.info.model ?? <span className="dim">—</span>}</td>
                  <td className="num">{c.info.host}</td>
                  <td className="num">
                    {Object.entries(c.bays).map(([n, b]) => (
                      <span key={n} className="bay" title={`Bay ${n}`}>
                        {n}:{b.batteryPresent.state === 'ok' && b.batteryPresent.value ? (b.chargePercent.state === 'ok' ? `${b.chargePercent.value}%` : '?') : '–'}
                      </span>
                    ))}
                  </td>
                  <td>{c.info.storageMode ? <span className="tag tag--warn">Storage</span> : 'Charge'}</td>
                  <Status s={c.status} now={now} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
