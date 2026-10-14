import { useCallback, useEffect, useState } from 'react';

/**
 * Which details each channel tile shows. A per-screen preference: the RF
 * table laptop might show everything while a stage-side TV shows just the
 * meters. Saved in this browser only; it never affects other screens.
 */
export type TileField = 'transmitter' | 'battery' | 'runtime' | 'rf' | 'audio' | 'frequency' | 'quality' | 'alerts';

export const TILE_FIELDS: Array<{ id: TileField; label: string; hint: string }> = [
  { id: 'transmitter', label: 'Transmitter', hint: 'Role, model and ID line' },
  { id: 'battery', label: 'Battery', hint: 'Bars and charge' },
  { id: 'runtime', label: 'Runtime', hint: 'Time left on the battery' },
  { id: 'rf', label: 'RF meters', hint: 'Signal strength per antenna' },
  { id: 'audio', label: 'Audio meter', hint: 'Live audio level' },
  { id: 'frequency', label: 'Frequency', hint: 'MHz and status tags' },
  { id: 'quality', label: 'Link quality', hint: 'Axient Digital 0–5' },
  { id: 'alerts', label: 'Alert line', hint: 'Top problem for the channel' },
];

export type DisplayOptions = Record<TileField, boolean>;

const ALL_ON: DisplayOptions = Object.fromEntries(TILE_FIELDS.map((f) => [f.id, true])) as DisplayOptions;
const KEY = 'rf-ranger.display.v1';

function load(): DisplayOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DisplayOptions>;
    return { ...ALL_ON, ...saved };
  } catch {
    return ALL_ON; // storage blocked (private window, kiosk): show everything
  }
}

export function useDisplayOptions() {
  const [options, setOptions] = useState<DisplayOptions>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
      // can't persist here; the choice still applies until reload
    }
  }, [options]);

  const toggle = useCallback((field: TileField) => setOptions((o) => ({ ...o, [field]: !o[field] })), []);
  const reset = useCallback(() => setOptions(ALL_ON), []);
  return { options, toggle, reset };
}
