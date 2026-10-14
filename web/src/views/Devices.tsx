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

/** Network and integration status for every configured device. */
export function Devices({ live }: { live: Live }) {
  const s = live.snapshot;
  if (!s) return <div className="empty">Connecting to RF Ranger…</div>;
  const now = s.serverTime;

  return (
    <div className="devices">
      {s.mode === 'live' && (
        <section>
          <h2 className="section-title">Found on the network</h2>
          {s.discovered.length === 0 ? (
            <p className="dim">
              Listening for Shure devices… They announce themselves every so often, so this can take a minute. If nothing appears, check
              this computer is on the same network as the receivers, or start with <code>--receiver &lt;ip&gt;</code>.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Address</th><th>Model</th><th>Device ID</th><th>Type</th><th>Found by</th><th>Status</th><th>Note</th></tr>
              </thead>
              <tbody>
                {s.discovered.map((d) => (
                  <tr key={d.host}>
                    <td className="num strong">{d.host}</td>
                    <td>{d.model ?? <span className="dim">—</span>}</td>
                    <td>{d.deviceId ?? <span className="dim">—</span>}</td>
                    <td>{d.kind ? d.kind.toUpperCase() : <span className="dim">—</span>}</td>
                    <td className="dim">{d.source === 'manual' ? 'Address given' : 'Discovery'}</td>
                    <td><span className={`found found--${d.state}`}>{FOUND_TEXT[d.state]}</span></td>
                    <td className="dim">{d.note ?? ''}</td>
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
