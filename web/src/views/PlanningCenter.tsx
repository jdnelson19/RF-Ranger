import { useEffect, useMemo, useState } from 'react';
import type { PcoStatus, ServiceType, UpcomingSummary } from '../types';

const TOKENS_URL = 'https://api.planningcenteronline.com/oauth/applications';

// The server gives up on Planning Center after 15 s a request; this only catches a server that stops answering.
const API_TIMEOUT_MS = 60_000;

async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/pco${path}`, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      ...(body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error("RF Ranger didn't answer. Check that it's still running, then try again.");
    throw new Error(`Can't reach RF Ranger: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data;
}

/**
 * Link this church's Planning Center account. Each install links its own
 * account; the token stays on this computer and is never shown again.
 */
export function PlanningCenter() {
  const [status, setStatus] = useState<PcoStatus | undefined>();
  const [forbidden, setForbidden] = useState(false);
  const [types, setTypes] = useState<ServiceType[]>([]);
  const [typesError, setTypesError] = useState<string | undefined>();
  const [upcoming, setUpcoming] = useState<UpcomingSummary | undefined>();
  const [upcomingError, setUpcomingError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = async (check = false) => {
    setError(undefined);
    try {
      const s = await api<PcoStatus>(check ? '?check=1' : '');
      setStatus(s);
      if (!s.connected) return;
      setTypesError(undefined);
      try {
        setTypes((await api<{ serviceTypes: ServiceType[] }>('/service-types')).serviceTypes);
      } catch (e) {
        setTypesError((e as Error).message);
      }
    } catch (e) {
      if ((e as { status?: number }).status === 403) setForbidden(true);
      else setError((e as Error).message);
    }
  };

  useEffect(() => { void load(true); }, []);

  // Show what RF Ranger would prepare for, once a service type is chosen.
  const typeId = status?.connected ? status.serviceType?.id : undefined;
  const [upcomingTry, setUpcomingTry] = useState(0);
  useEffect(() => {
    setUpcoming(undefined);
    setUpcomingError(undefined);
    if (!typeId) return;
    let current = true;
    api<UpcomingSummary>('/upcoming').then(
      (u) => current && setUpcoming(u),
      (e: Error) => current && setUpcomingError(e.message),
    );
    return () => { current = false; };
  }, [typeId, upcomingTry]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return (
      <div className="empty">
        <p className="empty__title">Planning Center settings are only available on the computer running RF Ranger.</p>
        <p>Open RF Ranger on that computer to connect or change the Planning Center account.</p>
      </div>
    );
  }
  if (!status) {
    return error ? (
      <div className="empty">
        <p className="empty__title">Couldn't check Planning Center</p>
        <p>{error}</p>
        <p><button type="button" className="btn btn--primary" onClick={() => { setError(undefined); void load(true); }}>Try again</button></p>
      </div>
    ) : (
      <div className="empty">Checking Planning Center…</div>
    );
  }

  return (
    <div className="pco">
      {status.connected || (status.configured && status.error) ? (
        <Connected
          status={status}
          types={types}
          typesError={typesError}
          upcoming={upcoming}
          upcomingError={upcomingError}
          retryUpcoming={() => setUpcomingTry((n) => n + 1)}
          busy={busy}
          run={run}
          load={load}
          setStatus={setStatus}
        />
      ) : (
        <Connect busy={busy} run={run} onConnected={(s, t) => { setStatus(s); setTypes(t); setTypesError(undefined); }} />
      )}
      {error && <p className="pco__error" role="alert">{error}</p>}
    </div>
  );
}

function Connect({ busy, run, onConnected }: {
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  onConnected: (s: PcoStatus, types: ServiceType[]) => void;
}) {
  const [appId, setAppId] = useState('');
  const [secret, setSecret] = useState('');

  return (
    <section className="pco__card">
      <h2 className="section-title">Connect Planning Center</h2>
      <p className="pco__lead">
        Link your church's Planning Center account to fill the pickup screen with who's scheduled for the next service.
        RF Ranger only reads from Planning Center.
      </p>
      <ol className="pco__steps">
        <li>
          Sign in at <a className="link" href={TOKENS_URL} target="_blank" rel="noreferrer">Planning Center developer settings</a>.
        </li>
        <li>Under <b>Personal Access Tokens</b>, create a new token (call it "RF Ranger").</li>
        <li>Copy its <b>Application ID</b> and <b>Secret</b> into the boxes below.</li>
      </ol>
      <form
        className="pco__form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ status: PcoStatus; serviceTypes: ServiceType[] }>('/connect', { appId, secret });
            setSecret('');
            onConnected(r.status, r.serviceTypes);
          });
        }}
      >
        <label className="pco__field">
          <span>Application ID</span>
          <input className="input input--mono" value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" spellCheck={false} required />
        </label>
        <label className="pco__field">
          <span>Secret</span>
          <input className="input input--mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" required />
        </label>
        <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Checking…' : 'Connect'}</button>
      </form>
      <p className="pco__note">
        The token is checked with Planning Center before it's saved, and is stored only for your user account on this
        computer. It can read whatever your Planning Center account can see, so treat it like a password.
      </p>
    </section>
  );
}

function Connected({ status, types, typesError, upcoming, upcomingError, retryUpcoming, busy, run, load, setStatus }: {
  status: PcoStatus;
  types: ServiceType[];
  typesError: string | undefined;
  upcoming: UpcomingSummary | undefined;
  upcomingError: string | undefined;
  retryUpcoming: () => void;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  load: (check?: boolean) => Promise<void>;
  setStatus: (s: PcoStatus) => void;
}) {
  // Service type names aren't unique (e.g. two "Special Services"), so show the ID where they collide.
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of types) counts.set(t.name.trim(), (counts.get(t.name.trim()) ?? 0) + 1);
    return [...types]
      .sort((a, b) => a.name.trim().localeCompare(b.name.trim()))
      .map((t) => ({ id: t.id, label: (counts.get(t.name.trim()) ?? 0) > 1 ? `${t.name.trim()} (ID ${t.id})` : t.name.trim() }));
  }, [types]);
  const tz = status.organization?.timeZone;

  return (
    <>
      <section className="pco__card">
        <h2 className="section-title">Planning Center</h2>
        <div className="pco__account">
          <span className={`conn conn--${status.connected ? 'connected' : 'disconnected'}`}><span className="conn__dot" />{status.connected ? 'Connected' : 'Not connected'}</span>
          <span className="pco__org">{status.organization?.name ?? 'Planning Center'}</span>
          <span className="dim">
            {status.source === 'environment' ? 'token from environment variables' : `token …${status.tokenHint}`}
          </span>
          <span className="pco__actions">
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => load(true))}>Check connection</button>
            {status.source !== 'environment' && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm('Disconnect Planning Center? The token is deleted from this computer.')) return;
                  void run(async () => setStatus(await api<PcoStatus>('/disconnect', {})));
                }}
              >
                Disconnect
              </button>
            )}
          </span>
        </div>
        {!status.connected && status.error && <p className="pco__error">{status.error}</p>}
      </section>

      {status.connected && (
        <section className="pco__card">
          <h2 className="section-title">Service to follow</h2>
          <label className="pco__field">
            <span>Service type</span>
            <select
              className="input"
              value={status.serviceType?.id ?? ''}
              disabled={busy || !options.length}
              onChange={(e) => {
                const id = e.target.value;
                if (id) void run(async () => setStatus(await api<PcoStatus>('/service-type', { id })));
              }}
            >
              <option value="" disabled>{options.length ? 'Choose a service type…' : typesError ? "Service types didn't load" : 'Loading service types…'}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          {typesError && !options.length && (
            <p className="pco__error" role="alert">
              {typesError}{' '}
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => load())}>Try again</button>
            </p>
          )}

          {status.serviceType && (
            upcoming ? <Upcoming u={upcoming} tz={tz} />
              : upcomingError ? (
                <p className="pco__error" role="alert">
                  {upcomingError}{' '}
                  <button type="button" className="btn btn--ghost btn--sm" onClick={retryUpcoming}>Try again</button>
                </p>
              )
              : <p className="dim">Looking up the next service…</p>
          )}
        </section>
      )}

      <p className="pco__note">
        Next: linking Planning Center positions (Worship Leader, BGV…) to RF slots, so names and photos fill in on their
        own. A one-click "Sign in with Planning Center" is planned to replace pasting a token.
      </p>
    </>
  );
}

function Upcoming({ u, tz }: { u: UpcomingSummary; tz?: string }) {
  if (!u.plan) return <p className="dim">No upcoming plans for {u.serviceType.name}.</p>;
  const time = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  const p = u.plan;
  return (
    <div className="pco__upcoming">
      <div className="pco__plan-date">{p.dates}</div>
      {(p.title || p.seriesTitle) && <div className="pco__plan-title">{[p.title, p.seriesTitle && `(${p.seriesTitle})`].filter(Boolean).join(' ')}</div>}
      <dl className="kv">
        <dt>Services</dt><dd>{p.serviceTimes.length ? p.serviceTimes.map(time).join(' · ') : <span className="dim">no service times</span>}</dd>
        <dt>Scheduled</dt>
        <dd>
          {u.scheduled} people
          {(u.declined > 0 || u.unconfirmed > 0) && <span className="dim">{` · ${u.declined} declined · ${u.unconfirmed} unconfirmed`}</span>}
        </dd>
        {p.endsAt && <><dt>Next plan from</dt><dd>{time(p.endsAt)} <span className="dim">(when this one's last service ends)</span></dd></>}
      </dl>
    </div>
  );
}
