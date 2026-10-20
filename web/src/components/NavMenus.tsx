import { useEffect, useState } from 'react';
import { href, navigate, type Route } from '../route';
import type { ShowPreset } from '../types';

/** Close a menu with Escape. */
function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
}

/**
 * The engineer grid's first tab: what it shows (all channels or a show
 * preset) as a dropdown, with an edit button on each preset and "New preset".
 */
export function PresetMenu({ presets, active, route, onEdit, onNew, disabled }: {
  presets: ShowPreset[];
  active: ShowPreset | undefined;
  route: Route;
  onEdit: (p: ShowPreset) => void;
  onNew: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEscape(open, close);
  const onGrid = route.view === 'engineer';
  const pick = (show: string | undefined) => {
    close();
    navigate({ view: 'engineer', group: route.group, show });
  };

  return (
    <div className="menu">
      <button type="button" className={`tab tab--menu${onGrid ? ' tab--active' : ''}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        {active ? active.name : 'All channels'} <span className="tab__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={close} />
          <div className="popover popover--left" role="menu" aria-label="Channels to show">
            <button type="button" role="menuitemradio" aria-checked={!active} className={`menu__item${!active ? ' menu__item--on' : ''}`} onClick={() => pick(undefined)}>
              <span className="menu__check" aria-hidden="true">{!active ? '✓' : ''}</span>
              <span className="menu__name">All channels</span>
            </button>
            {presets.map((p) => (
              <div key={p.id} className={`menu__row${active?.id === p.id ? ' menu__item--on' : ''}`}>
                <button type="button" role="menuitemradio" aria-checked={active?.id === p.id} className="menu__item" onClick={() => pick(p.id)}>
                  <span className="menu__check" aria-hidden="true">{active?.id === p.id ? '✓' : ''}</span>
                  <span className="menu__name">{p.name}</span>
                  <span className="dim menu__count">{p.slots.length}</span>
                </button>
                <button type="button" className="icon-btn menu__edit" aria-label={`Edit ${p.name}`} title={`Edit ${p.name}`}
                  onClick={() => { close(); onEdit(p); }}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.7 1.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4L5.4 13.6 1.5 14.5l.9-3.9 9.3-9.3ZM3.3 11.2l-.4 1.9 1.9-.4 7.4-7.4-1.5-1.5-7.4 7.4Z"/></svg>
                </button>
              </div>
            ))}
            <div className="menu__sep" />
            <button type="button" className="menu__item menu__item--new" disabled={disabled} onClick={() => { close(); onNew(); }}>
              <span className="menu__check" aria-hidden="true">+</span>
              <span className="menu__name">New preset</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The cog: settings pages that aren't needed during a show (Planning Center, Inspector). */
export function SettingsMenu({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useEscape(open, close);
  const here = route.view === 'planning-center' || route.view === 'inspector';
  const items: Array<{ view: Route['view']; label: string; hint: string }> = [
    { view: 'planning-center', label: 'Planning Center', hint: 'Account, services and mic assignments' },
    { view: 'inspector', label: 'Inspector', hint: 'Raw messages from each device' },
  ];

  return (
    <div className="menu">
      <button type="button" className={`icon-btn settings-btn${here ? ' settings-btn--on' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label="Settings" title="Settings" onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.3-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" transform="translate(-1 0)"/></svg>
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={close} />
          <div className="popover" role="menu" aria-label="Settings">
            <div className="popover__title">Settings</div>
            {items.map((i) => (
              <a key={i.view} role="menuitem" className={`menu__item${route.view === i.view ? ' menu__item--on' : ''}`} href={href({ view: i.view })} onClick={close}>
                <span className="menu__name">{i.label}<span className="dim menu__hint">{i.hint}</span></span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
