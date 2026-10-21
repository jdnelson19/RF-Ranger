import { useEffect, useMemo, useState } from 'react';
import { MicAssignments } from '../components/MicAssignments';
import type { PcoStatus, ServiceType, ShowPreset, SlotView } from '../types';

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
export function PlanningCenter({ slots, presets, pickupPreset, autoStar = true }: { slots: SlotView[]; presets: ShowPreset[]; pickupPreset?: string; autoStar?: boolean }) {
  const [status, setStatus] = useState<PcoStatus | undefined>();
  const [forbidden, setForbidden] = useState(false);
  const [types, setTypes] = useState<ServiceType[]>([]);
  const [typesError, setTypesError] = useState<string | undefined>();
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
          busy={busy}
          run={run}
          load={load}
          setStatus={setStatus}
          slots={slots}
          presets={presets}
          pickupPreset={pickupPreset}
          autoStar={autoStar}
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

function Connected({ status, types, typesError, busy, run, load, setStatus, slots, presets, pickupPreset, autoStar }: {
  status: PcoStatus;
  types: ServiceType[];
  typesError: string | undefined;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  load: (check?: boolean) => Promise<void>;
  setStatus: (s: PcoStatus) => void;
  slots: SlotView[];
  presets: ShowPreset[];
  pickupPreset?: string;
  autoStar: boolean;
}) {
  // Service type names aren't unique (e.g. two "Special Services"), so show the ID where they collide.
  const options = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of types) counts.set(t.name.trim(), (counts.get(t.name.trim()) ?? 0) + 1);
    return [...types]
      .sort((a, b) => a.name.trim().localeCompare(b.name.trim()))
      .map((t) => ({ id: t.id, label: (counts.get(t.name.trim()) ?? 0) > 1 ? `${t.name.trim()} (ID ${t.id})` : t.name.trim() }));
  }, [types]);

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

      {status.connected && typesError && !types.length && (
        <p className="pco__error" role="alert">
          Service types didn't load: {typesError}{' '}
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void run(() => load())}>Try again</button>
        </p>
      )}

      {status.connected && <MicAssignments slots={slots} presets={presets} pickupPreset={pickupPreset} autoStar={autoStar} types={options.map((o) => ({ id: o.id, name: o.label }))} />}

      <p className="pco__note">
        A one-click "Sign in with Planning Center" is planned to replace pasting a token.
      </p>
    </>
  );
}

