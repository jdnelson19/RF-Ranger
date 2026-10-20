/**
 * Who is on which mic this service, from Planning Center.
 *
 * Rules are set up once: which teams carry wireless (e.g. Vocals), and for
 * each of their positions the mics it uses ("Worship Leader" → RF1–RF3,
 * "BGV 1" → RF5), with optional preferences inside a position ("Josh prefers
 * RF1"). "Sync from Planning Center" applies them to the upcoming plan and
 * produces a roster; the A1 can then change any mic by hand. The roster is
 * what the engineer and pickup screens show.
 *
 * Mics are identified by slot key (`receiverId/channel`), like show presets.
 * Pure: no I/O. Shared with the web UI.
 */

export interface MicPreference {
  personId: string;
  /** For display while that person isn't scheduled. */
  name: string;
  mic: string;
}

export interface RoleRule {
  teamId: string;
  /** Planning Center position name, matched without regard to case. */
  position: string;
  /** Slot keys in fill order. */
  mics: string[];
  prefer: MicPreference[];
}

export interface MicRules {
  /** Teams whose scheduled people get mics. */
  teamIds: string[];
  roles: RoleRule[];
}

export interface RosterEntry {
  name: string;
  /** The Planning Center position, shown as the person's role. */
  role?: string;
  personId?: string;
  photoUrl?: string;
  unconfirmed?: boolean;
  /** Filled by a sync, or set by hand afterwards. */
  source: 'planning-center' | 'manual';
}

/** Someone on a wireless team who didn't get a mic, and why. */
export interface Unplaced {
  personId: string;
  name: string;
  role: string;
  /** full: every mic for the role is taken; no-mics: the role has none; removed: taken off a mic by hand. */
  reason: 'full' | 'no-mics' | 'removed';
}

/** A scheduled person as the roster needs them (from Planning Center's team members). */
export interface RosterPerson {
  personId: string;
  name: string;
  teamId: string;
  position: string;
  status: 'confirmed' | 'unconfirmed' | 'declined';
  photoUrl?: string;
}

export interface Roster {
  plan?: { id: string; dates: string; title?: string };
  syncedAt?: number;
  entries: Record<string, RosterEntry>;
  unplaced: Unplaced[];
  /** Everyone scheduled on the wireless teams at the last sync, for changing a mic by hand. */
  people: RosterPerson[];
}

export const EMPTY_RULES: MicRules = { teamIds: [], roles: [] };
export const EMPTY_ROSTER: Roster = { entries: {}, unplaced: [], people: [] };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Give each scheduled person on a wireless team a mic. Per position, in the
 * order the rules list them: preferences first (a preferred mic that's in
 * the position's set and still free), then everyone else in Planning
 * Center's order onto the position's first free mic. People who declined are
 * skipped; anyone already placed (scheduled twice) keeps their first mic.
 */
export function assignMics(people: RosterPerson[], rules: MicRules): Pick<Roster, 'entries' | 'unplaced'> {
  const teams = new Set(rules.teamIds);
  const onWireless = people.filter((p) => teams.has(p.teamId) && p.status !== 'declined');
  const entries: Record<string, RosterEntry> = {};
  const unplaced: Unplaced[] = [];
  const placed = new Set<string>();
  const taken = (mic: string) => mic in entries;

  const put = (p: RosterPerson, mic: string) => {
    entries[mic] = {
      name: p.name,
      role: p.position || undefined,
      personId: p.personId,
      photoUrl: p.photoUrl,
      unconfirmed: p.status === 'unconfirmed' || undefined,
      source: 'planning-center',
    };
    placed.add(p.personId);
  };

  for (const rule of rules.roles) {
    const candidates = onWireless.filter((p) => p.teamId === rule.teamId && same(p.position, rule.position));
    for (const pref of rule.prefer) {
      const p = candidates.find((c) => c.personId === pref.personId && !placed.has(c.personId));
      if (p && rule.mics.includes(pref.mic) && !taken(pref.mic)) put(p, pref.mic);
    }
    for (const p of candidates) {
      if (placed.has(p.personId)) continue;
      const mic = rule.mics.find((m) => !taken(m));
      if (mic) put(p, mic);
    }
  }

  for (const p of onWireless) {
    if (placed.has(p.personId) || unplaced.some((u) => u.personId === p.personId)) continue;
    const rule = rules.roles.find((r) => r.teamId === p.teamId && same(r.position, p.position));
    unplaced.push({ personId: p.personId, name: p.name, role: p.position, reason: rule && rule.mics.length ? 'full' : 'no-mics' });
  }
  return { entries, unplaced };
}
