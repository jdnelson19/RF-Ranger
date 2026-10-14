import { useEffect, useMemo, useState } from 'react';
import type { ShowPreset, SlotView } from '../types';

/** Calls /api/presets; errors carry the server's explanation. */
export async function presetApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/presets${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/**
 * Create or edit a show preset: a name plus an ordered list of channels.
 * Order by dragging rows or with the arrow buttons (which also work on touch
 * screens and from the keyboard).
 */
export function ShowEditor({ slots, groups, preset, onClose, onSaved }: {
  slots: SlotView[];
  groups: string[];
  /** Undefined: create a new preset. */
  preset?: ShowPreset;
  onClose: () => void;
  onSaved: (id: string | undefined) => void;
}) {
  const [name, setName] = useState(preset?.name ?? '');
  const [keys, setKeys] = useState<string[]>(preset?.slots ?? []);
  const [filter, setFilter] = useState('');
  const [dragFrom, setDragFrom] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byKey = useMemo(() => new Map(slots.map((s) => [s.key, s])), [slots]);
  const chosen = new Set(keys);
  const available = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...slots]
      .sort((a, b) => a.slot - b.slot)
      .filter((s) => !chosen.has(s.key))
      .filter((s) => !q || [s.label, s.assignment?.artist, s.assignment?.role, s.group, s.receiverId].some((f) => f?.toLowerCase().includes(q)));
  }, [slots, keys, filter]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    const next = [...keys];
    const [k] = next.splice(from, 1);
    next.splice(to, 0, k!);
    setKeys(next);
  };
  const add = (...more: string[]) => setKeys((k) => [...k, ...more.filter((x) => !k.includes(x))]);

  const save = async (asNew: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const body = { name, slots: keys };
      const saved = preset && !asNew
        ? await presetApi<ShowPreset>(`/${encodeURIComponent(preset.id)}`, body)
        : await presetApi<ShowPreset>('', body);
      onSaved(saved.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!preset || !window.confirm(`Delete the "${preset.name}" preset? This affects every engineer screen.`)) return;
    setBusy(true);
    try {
      await presetApi(`/${encodeURIComponent(preset.id)}/delete`, {});
      onSaved(undefined);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal show-editor" role="dialog" aria-label={preset ? `Edit ${preset.name}` : 'New show preset'} onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>{preset ? 'Edit show preset' : 'New show preset'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <label className="show-editor__name">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Worship, Message, Announcements" maxLength={60} autoFocus />
        </label>

        <div className="show-editor__panes">
          <section className="show-editor__pane">
            <h3>In this preset <span className="dim">({keys.length})</span></h3>
            {keys.length === 0 ? (
              <p className="dim show-editor__hint">Add channels from the list. They show on screen in this order.</p>
            ) : (
              <ol className="show-editor__list">
                {keys.map((k, i) => {
                  const s = byKey.get(k);
                  return (
                    <li
                      key={k}
                      className={`show-editor__row${dragFrom === i ? ' show-editor__row--drag' : ''}`}
                      draggable
                      onDragStart={() => setDragFrom(i)}
                      onDragEnd={() => setDragFrom(undefined)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { if (dragFrom !== undefined) move(dragFrom, i); setDragFrom(undefined); }}
                    >
                      <span className="show-editor__grip" aria-hidden="true">⋮⋮</span>
                      <SlotLabel s={s} k={k} />
                      <span className="show-editor__btns">
                        <button type="button" className="icon-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">↑</button>
                        <button type="button" className="icon-btn" onClick={() => move(i, i + 1)} disabled={i === keys.length - 1} aria-label="Move down">↓</button>
                        <button type="button" className="icon-btn" onClick={() => setKeys(keys.filter((x) => x !== k))} aria-label="Remove">✕</button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="show-editor__pane">
            <h3>Add channels</h3>
            <div className="show-editor__quick">
              {groups.map((g) => {
                const inGroup = slots.filter((s) => s.group === g && !chosen.has(s.key)).map((s) => s.key);
                return inGroup.length ? (
                  <button key={g} type="button" className="chip" onClick={() => add(...inGroup)}>+ all {g}</button>
                ) : null;
              })}
            </div>
            <input className="search" type="search" placeholder="Search name, label, receiver…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <ul className="show-editor__list show-editor__list--available">
              {available.map((s) => (
                <li key={s.key}>
                  <button type="button" className="show-editor__add" onClick={() => add(s.key)}>
                    <span className="show-editor__plus" aria-hidden="true">+</span>
                    <SlotLabel s={s} k={s.key} />
                  </button>
                </li>
              ))}
              {available.length === 0 && <li className="dim show-editor__hint">{slots.length ? 'Every channel is in this preset.' : 'No channels yet.'}</li>}
            </ul>
          </section>
        </div>

        {error && <p className="pco__error" role="alert">{error}</p>}

        <footer className="modal__foot">
          {preset && <button type="button" className="btn btn--ghost" onClick={() => void remove()} disabled={busy}>Delete</button>}
          <span className="modal__spacer" />
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {preset && <button type="button" className="btn btn--ghost" onClick={() => void save(true)} disabled={busy}>Save as new</button>}
          <button type="button" className="btn btn--primary" onClick={() => void save(false)} disabled={busy || !name.trim() || keys.length === 0}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SlotLabel({ s, k }: { s: SlotView | undefined; k: string }) {
  if (!s) {
    return (
      <span className="show-editor__slot">
        <span className="show-editor__slot-label">{k}</span>
        <span className="dim">not connected</span>
      </span>
    );
  }
  return (
    <span className="show-editor__slot">
      <span className="show-editor__slot-label">{s.label}</span>
      <span className="show-editor__slot-name">{s.assignment?.artist ?? (s.telemetry.name.state === 'ok' ? s.telemetry.name.value : 'Unassigned')}</span>
      <span className="dim">{[s.group, `${s.receiverId} ch${s.channel}`].filter(Boolean).join(' · ')}</span>
    </span>
  );
}
