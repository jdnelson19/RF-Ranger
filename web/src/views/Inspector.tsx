import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Live } from '../useSnapshot';

// Mirrors server/src/server/inspector.ts (that module imports Node APIs, so its types aren't shared directly).
interface Frame { seq: number; t: number; dir: 'in' | 'out' | 'note'; frame: string }
interface KeyStat { key: string; channel?: number; value: string; count: number; lastSeen: number }
interface Tags { kind?: string; model?: string; firmware?: string; notes?: string }
interface SessionSummary { id: string; host: string; port: number; status: string; monitoredBy?: string; model?: string }
interface SessionView {
  id: string;
  host: string;
  port: number;
  status: string;
  monitoredBy?: string;
  identity?: { reachable: boolean; model?: string; deviceId?: string; kind?: string; channels?: number; unsupported?: string };
  tags: Tags;
  meteringUntil?: number;
  lastSeq: number;
  frames: Frame[];
  keys: KeyStat[];
}

const KINDS = ['', 'ULX-D', 'Axient Digital', 'SLX-D', 'QLX-D', 'UHF-R', 'PSM (in-ear)', 'Charger', 'Sennheiser', 'Other'];
const QUICK: Array<[string, string]> = [
  ['Get all', 'GET 0 ALL'],
  ['Model', 'GET MODEL'],
  ['Device ID', 'GET DEVICE_ID'],
  ['Firmware', 'GET FW_VER'],
  ['Ch 1 all', 'GET 1 ALL'],
];
const MAX_CLIENT_FRAMES = 5_000;
const ISSUE_URL = 'https://github.com/jdnelson19/RF-Ranger/issues/new?template=device-report.yml';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/inspector${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

/** Raw protocol view of any device, for diagnosing and for contributing device reports. */
export function Inspector({ live }: { live: Live }) {
  const [allowed, setAllowed] = useState<boolean | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api<{ sessions: SessionSummary[] }>('');
      setAllowed(true);
      setSessions(r.sessions);
      return r.sessions;
    } catch (e) {
      if ((e as { status?: number }).status === 403) setAllowed(false);
      else setError((e as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    void refreshSessions().then((s) => setSelected((cur) => cur ?? s[0]?.id));
    const t = window.setInterval(refreshSessions, 3_000);
    return () => window.clearInterval(t);
  }, [refreshSessions]);

  const open = async (host: string, port: string) => {
    setError(undefined);
    try {
      const { id } = await api<{ id: string }>('/open', { host, port: port || undefined });
      await refreshSessions();
      setSelected(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (allowed === false) {
    return (
      <div className="empty">
        <div className="empty__title">Inspector is only available on the computer running RF Ranger</div>
        <p className="dim">It can connect to devices and send queries, so it's disabled for other screens on the network.</p>
      </div>
    );
  }

  const known = suggestions(live);

  return (
    <div className="insp">
      <aside className="insp__side">
        <OpenForm onOpen={open} />
        {error && <p className="insp__error">{error}</p>}

        {sessions.length > 0 && (
          <>
            <h3 className="insp__h">Watching</h3>
            <ul className="insp__list">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button type="button" className={`insp__item${selected === s.id ? ' insp__item--on' : ''}`} onClick={() => setSelected(s.id)}>
                    <span className={`insp__dot insp__dot--${s.status}`} />
                    <span className="insp__item-host">{s.id}</span>
                    <span className="insp__item-model">{s.model ?? (s.monitoredBy ? s.monitoredBy : '')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {known.length > 0 && (
          <>
            <h3 className="insp__h">Known devices</h3>
            <ul className="insp__list">
              {known.map((k) => (
                <li key={k.id}>
                  <button type="button" className="insp__item" onClick={() => open(k.host, k.port)}>
                    <span className="insp__item-host">{k.id}</span>
                    <span className="insp__item-model">{k.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="insp__help">
          <b>Help support more hardware.</b> Have a model RF Ranger doesn't support yet? Watch it here, press <i>Get all</i>,
          tag what it is, then <i>Export report</i> and attach it to a{' '}
          <a className="link" href={ISSUE_URL} target="_blank" rel="noreferrer">device report</a>. Names and addresses are removed by default.
        </div>
      </aside>

      <section className="insp__main">
        {selected ? (
          <SessionPanel key={selected} id={selected} onClosed={async () => { setSelected(undefined); const s = await refreshSessions(); setSelected(s[0]?.id); }} />
        ) : (
          <div className="empty">
            <div className="empty__title">Watch a device's raw traffic</div>
            <p className="dim">Enter an address on the left, or pick a known device. Only read-only queries can be sent.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function OpenForm({ onOpen }: { onOpen: (host: string, port: string) => void }) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (host.trim()) onOpen(host.trim(), port.trim());
  };
  return (
    <form className="insp__open" onSubmit={submit}>
      <h3 className="insp__h">Watch a device</h3>
      <div className="insp__row">
        <input className="input" placeholder="IP address" value={host} onChange={(e) => setHost(e.target.value)} aria-label="IP address" />
        <input className="input input--port" placeholder="2202" value={port} onChange={(e) => setPort(e.target.value)} aria-label="Port" />
      </div>
      <button type="submit" className="btn btn--primary">Watch</button>
    </form>
  );
}

function SessionPanel({ id, onClosed }: { id: string; onClosed: () => void }) {
  const [view, setView] = useState<Omit<SessionView, 'frames'>>();
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hideSamples, setHideSamples] = useState(true);
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [command, setCommand] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string }>();
  const [anonymize, setAnonymize] = useState(true);
  const lastSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const v = await api<SessionView>(`/view?id=${encodeURIComponent(id)}&after=${lastSeq.current}`);
        if (stop) return;
        const { frames: fresh, ...rest } = v;
        setView(rest);
        if (fresh.length) {
          lastSeq.current = fresh[fresh.length - 1]!.seq;
          setFrames((f) => [...f, ...fresh].slice(-MAX_CLIENT_FRAMES));
        }
      } catch {
        /* session closed or server gone; the list refresh will notice */
      }
    };
    void tick();
    const t = window.setInterval(tick, 500);
    return () => { stop = true; window.clearInterval(t); };
  }, [id]);

  const shown = useMemo(() => {
    const q = filter.trim().toUpperCase();
    return frames.filter((f) => (!hideSamples || !f.frame.includes('SAMPLE')) && (!q || f.frame.toUpperCase().includes(q))).slice(-1_500);
  }, [frames, hideSamples, filter]);

  // Follow the newest line unless paused.
  useEffect(() => {
    if (!paused && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [shown, paused]);

  const send = async (cmd: string) => {
    setMessage(undefined);
    try {
      await api('/send', { id, command: cmd });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    }
  };

  const meter = async () => {
    try {
      await api('/meter', { id, seconds: 30 });
    } catch (e) {
      setMessage({ tone: 'bad', text: (e as Error).message });
    }
  };

  const close = async () => {
    await api('/close', { id }).catch(() => {});
    onClosed();
  };

  if (!view) return <div className="empty">Opening…</div>;
  const idn = view.identity;
  const metering = view.meteringUntil && view.meteringUntil > Date.now();

  return (
    <div className="insp__session">
      <header className="insp__head">
        <div>
          <div className="insp__title">
            <span className={`insp__dot insp__dot--${view.status}`} /> {view.host}:{view.port}
          </div>
          <div className="dim insp__sub">
            {view.monitoredBy ? <>Monitored by RF Ranger as <b>{view.monitoredBy}</b> · </> : null}
            {idn ? (idn.reachable ? `${idn.model ?? 'Unknown model'}${idn.kind ? ` · ${idn.kind.toUpperCase()}` : ''}${idn.channels ? ` · ${idn.channels} ch` : ''}${idn.unsupported ? ` · ${idn.unsupported}` : ''}` : 'No answer on the control port') : 'Identifying…'}
          </div>
        </div>
        <div className="insp__actions">
          <label className="check"><input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} /> Remove names &amp; addresses</label>
          <a className="btn btn--primary" href={`/api/inspector/report?id=${encodeURIComponent(id)}&anonymize=${anonymize ? 1 : 0}`} download>Export report</a>
          <button type="button" className="btn btn--ghost" onClick={close}>Stop watching</button>
        </div>
      </header>

      <div className="insp__controls">
        <div className="insp__quick">
          {QUICK.map(([label, cmd]) => (
            <button key={cmd} type="button" className="chip" onClick={() => send(cmd)} title={cmd}>{label}</button>
          ))}
          <button type="button" className="chip" onClick={meter} disabled={!!view.monitoredBy || !!metering}
            title={view.monitoredBy ? 'Already metered by RF Ranger' : 'Turn meters on for 30 seconds to capture SAMPLE messages'}>
            {metering ? 'Metering…' : 'Sample meters 30 s'}
          </button>
        </div>
        <form className="insp__cmd" onSubmit={(e) => { e.preventDefault(); if (command.trim()) { void send(command); } }}>
          <input className="input input--mono" placeholder="GET 1 BATT_BARS" value={command} onChange={(e) => setCommand(e.target.value)} aria-label="Command" />
          <button type="submit" className="btn btn--ghost">Send</button>
        </form>
        {message && <span className={`insp__msg insp__msg--${message.tone}`}>{message.text}</span>}
      </div>

      <div className="insp__panes">
        <div className="insp__logwrap">
          <div className="insp__logbar">
            <input className="input input--sm" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter log" />
            <label className="check"><input type="checkbox" checked={hideSamples} onChange={(e) => setHideSamples(e.target.checked)} /> Hide meter samples</label>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFrames([])}>Clear</button>
            <span className="dim insp__count">{shown.length} lines</span>
          </div>
          <div className="insp__log" ref={logRef}>
            {shown.map((f) => (
              <div key={f.seq} className={`logline logline--${f.dir}${f.frame.includes('SAMPLE') ? ' logline--sample' : ''}${f.frame.includes('REP ERR') ? ' logline--err' : ''}`}>
                <span className="logline__t">{time(f.t)}</span>
                <span className="logline__d">{f.dir === 'in' ? '←' : f.dir === 'out' ? '→' : '•'}</span>
                <span className="logline__f">{f.frame}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="insp__keys">
          <h3 className="insp__h">Fields reported ({view.keys.length})</h3>
          <div className="insp__keys-scroll">
            <table className="table table--compact">
              <thead><tr><th>Ch</th><th>Key</th><th>Latest value</th><th>#</th></tr></thead>
              <tbody>
                {view.keys.map((k) => (
                  <tr key={`${k.channel ?? '-'}:${k.key}`}>
                    <td className="num">{k.channel ?? '—'}</td>
                    <td className="num strong">{k.key}</td>
                    <td className="num">{k.value}</td>
                    <td className="num dim">{k.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TagForm id={id} initial={view.tags} />
        </div>
      </div>
    </div>
  );
}

function TagForm({ id, initial }: { id: string; initial: Tags }) {
  const [tags, setTags] = useState<Tags>(initial);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof Tags) => (e: { target: { value: string } }) => { setTags((t) => ({ ...t, [k]: e.target.value })); setSaved(false); };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api('/tags', { id, tags });
    setSaved(true);
  };
  return (
    <form className="insp__tags" onSubmit={save}>
      <h3 className="insp__h">What is this device?</h3>
      <div className="insp__grid2">
        <label>Type
          <select className="input" value={tags.kind ?? ''} onChange={set('kind')}>
            {KINDS.map((k) => <option key={k} value={k}>{k || 'Choose…'}</option>)}
          </select>
        </label>
        <label>Model<input className="input" placeholder="e.g. ULXD4Q" value={tags.model ?? ''} onChange={set('model')} /></label>
        <label>Firmware<input className="input" placeholder="e.g. 2.7.6" value={tags.firmware ?? ''} onChange={set('firmware')} /></label>
      </div>
      <label>Notes<textarea className="input" rows={3} placeholder="Transmitters, batteries, anything that looked wrong…" value={tags.notes ?? ''} onChange={set('notes')} /></label>
      <button type="submit" className="btn btn--ghost">{saved ? 'Saved ✓' : 'Save tags'}</button>
    </form>
  );
}

function suggestions(live: Live): Array<{ id: string; host: string; port: string; label: string }> {
  const s = live.snapshot;
  if (!s) return [];
  const out = new Map<string, { id: string; host: string; port: string; label: string }>();
  for (const d of s.discovered) {
    const [host, port = ''] = d.host.split(':');
    out.set(d.host, { id: d.host, host: host!, port, label: d.model ?? d.state });
  }
  for (const r of s.receivers) if (![...out.values()].some((o) => o.host === r.info.host)) out.set(r.info.host, { id: r.info.host, host: r.info.host, port: '', label: r.info.id });
  for (const c of s.chargers) if (![...out.values()].some((o) => o.host === c.info.host)) out.set(c.info.host, { id: c.info.host, host: c.info.host, port: '', label: c.info.id });
  return [...out.values()];
}

function time(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
