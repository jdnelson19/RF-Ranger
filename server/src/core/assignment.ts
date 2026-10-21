/** Slot and assignment shapes, shared by config and the wire format. */

/** Who a slot is for. Kept apart from the hardware it points at. */
export interface AssignmentConfig {
  artist: string;
  role?: string;
  /** File name under the photos directory, or a URL. */
  photo?: string;
  /** Transmitter identity this artist should be using, where the family reports one. */
  expectedTxId?: string;
  /** Where the transmitter is stored between uses. */
  charger?: { id: string; bay: number };
  notes?: string;
}

export interface SlotConfig {
  slot: number;
  receiver: string;
  channel: number;
  /** Short equipment label, e.g. "H1" or "BP7". */
  label?: string;
  kind?: 'handheld' | 'bodypack' | 'iem' | 'other';
  group?: string;
  assignment?: AssignmentConfig;
  /**
   * Take the label and artist from the receiver's channel name instead of
   * config (quick-start mode, like Micboard). Unnamed channels show as spare.
   */
  autoName?: boolean;
}

/**
 * Split a receiver channel name into an equipment ID and a person, the way
 * Micboard does: "H01 Fatai" -> { id: "H01", name: "Fatai" }, "BP-3" -> { id: "BP-3" },
 * "Pastor Dan" -> { name: "Pastor Dan" }.
 */
export function splitChannelName(raw: string): { id?: string; name?: string } {
  const parts = raw.trim().replace(/_/g, ' ').split(/\s+/).filter(Boolean);
  const [first, second, ...rest] = parts;
  if (!first) return {};
  if (/^[A-Za-z]*-?\d+$/.test(first)) return { id: first, name: [second, ...rest].join(' ') || undefined };
  // "BGV 1", "RF 2 Sam": a short word then a number is the label too.
  if (second && /^[A-Za-z]{1,6}$/.test(first) && /^\d{1,3}$/.test(second)) return { id: `${first} ${second}`, name: rest.join(' ') || undefined };
  return { name: parts.join(' ') };
}
