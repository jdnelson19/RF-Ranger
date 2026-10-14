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
  kind?: 'handheld' | 'bodypack' | 'other';
  group?: string;
  assignment?: AssignmentConfig;
}
