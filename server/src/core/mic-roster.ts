/**
 * Who is on which mic, from Planning Center.
 *
 * Each service (a Planning Center service type) has rules set up once: which
 * teams carry wireless (e.g. Vocals), and for each of their positions the
 * mics it uses ("Worship Leader" → RF1–RF3, "BGV 1" → RF5), with optional
 * preferences inside a position ("Sam prefers RF1"). Syncing a service
 * applies its rules to its upcoming plan; the A1 can then change any mic by
 * hand. The roster is what the engineer and pickup screens show.
 *
 * Mics are identified by slot key (`receiverId/channel`), like show presets.
 * Pure: no I/O. Shared with the web UI.
 */

export interface MicPreference {
  personId: string;
  /** For display while that person isn't scheduled. */
  name: string;
  /** Their mic, one of the position's; left out when only an IEM is preferred. */
  mic?: string;
  /** Their in-ear monitor channel (slot key): a sync puts them on it, so it pairs with their mic. */
  iem?: string;
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

/**
 * When a service syncs on its own: a set time before its next plan's first
 * rehearsal or service time (once per plan), or at a fixed time every week
 * on the RF Ranger computer's clock.
 */
export type AutoSyncRule =
  | { kind: 'before'; leadMinutes: number }
  /** `day`: 0 Sunday to 6 Saturday; `time`: "HH:MM", 24-hour. */
  | { kind: 'weekly'; day: number; time: string };

/**
 * One Planning Center service type RF Ranger fills mics from, e.g. a weekend
 * service, a youth night and a midweek service in the same room. Teams and
 * positions belong to a service type, so each has its own mic rules.
 */
export interface ServiceSetup {
  id: string;
  serviceTypeId: string;
  /** The service type's name, for display. */
  name: string;
  rules: MicRules;
  autoSync?: AutoSyncRule;
}

/** The last sync of one service. */
export interface ServiceSync {
  plan: { id: string; dates: string; title?: string };
  syncedAt: number;
  automatic?: boolean;
  /** People on its wireless teams who got no mic. */
  unplaced: Unplaced[];
  /** Everyone scheduled on its wireless teams, for changing a mic by hand. */
  people: RosterPerson[];
}

export interface Roster {
  /** Mic (slot key) → who is on it now. */
  entries: Record<string, RosterEntry & { serviceId?: string }>;
  /** By service id. */
  synced: Record<string, ServiceSync>;
}

/** One service's scheduled sync, as the Planning Center screen shows it (see server/auto-sync.ts). */
export interface AutoSyncInfo {
  /** When it will sync next, and the plan it expects (absent for a weekly sync that hasn't looked yet). */
  next?: { at: number; planDates?: string };
  /** Synced on its own for this plan; it won't again, so changes made since stay. */
  done?: { planDates: string };
  error?: string;
  checkedAt?: number;
}

export const EMPTY_RULES: MicRules = { teamIds: [], roles: [] };
export const EMPTY_ROSTER: Roster = { entries: {}, synced: {} };

/** The mics a service's rules use. A sync of that service replaces just these (and its own earlier entries). */
export function serviceMics(rules: MicRules): Set<string> {
  return new Set(rules.roles.flatMap((r) => r.mics));
}

/** Everyone from every service's last sync, once each, for the "who's on this mic" picker. */
export function rosterPeople(roster: Roster): RosterPerson[] {
  const seen = new Map<string, RosterPerson>();
  for (const s of Object.values(roster.synced)) for (const p of s.people) if (!seen.has(p.personId)) seen.set(p.personId, p);
  return [...seen.values()];
}

/**
 * The next time a weekly sync is due strictly after `after`, on this
 * computer's clock (so daylight saving is handled by the Date object).
 */
export function nextWeekly(rule: { day: number; time: string }, after: number): number {
  const [h, m] = rule.time.split(':').map(Number) as [number, number];
  const d = new Date(after);
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + ((rule.day - d.getDay() + 7) % 7));
  if (d.getTime() <= after) d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** The most recent time a weekly sync was due, at or before `at`. */
export function lastWeekly(rule: { day: number; time: string }, at: number): number {
  const next = new Date(nextWeekly(rule, at));
  next.setDate(next.getDate() - 7);
  return next.getTime();
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Give each scheduled person on a wireless team a mic. Per position, in the
 * order the rules list them: preferences first (a preferred mic that's in
 * the position's set and still free), then everyone else in Planning
 * Center's order onto the position's first free mic. People who declined are
 * skipped; anyone already placed (scheduled twice) keeps their first mic.
 */
export function assignMics(people: RosterPerson[], rules: MicRules): { entries: Record<string, RosterEntry>; unplaced: Unplaced[] } {
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
      if (p && pref.mic && rule.mics.includes(pref.mic) && !taken(pref.mic)) put(p, pref.mic);
    }
    for (const p of candidates) {
      if (placed.has(p.personId)) continue;
      const mic = rule.mics.find((m) => !taken(m));
      if (mic) put(p, mic);
    }
  }

  // Preferred in-ear channels, for everyone who got a mic (first preference wins a shared IEM).
  for (const rule of rules.roles) {
    for (const pref of rule.prefer) {
      if (!pref.iem || taken(pref.iem) || !placed.has(pref.personId)) continue;
      const p = onWireless.find((c) => c.personId === pref.personId)!;
      entries[pref.iem] = { name: p.name, role: p.position || undefined, personId: p.personId, photoUrl: p.photoUrl, unconfirmed: p.status === 'unconfirmed' || undefined, source: 'planning-center' };
    }
  }

  for (const p of onWireless) {
    if (placed.has(p.personId) || unplaced.some((u) => u.personId === p.personId)) continue;
    const rule = rules.roles.find((r) => r.teamId === p.teamId && same(r.position, p.position));
    unplaced.push({ personId: p.personId, name: p.name, role: p.position, reason: rule && rule.mics.length ? 'full' : 'no-mics' });
  }
  return { entries, unplaced };
}
