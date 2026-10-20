/**
 * Mic rules and this service's roster (see core/mic-roster.ts), saved on the
 * RF Ranger computer so a restart keeps the week's assignments and any
 * changes the A1 made by hand.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EMPTY_ROSTER, EMPTY_RULES, assignMics, type MicRules, type Roster, type RosterEntry, type RosterPerson } from '../core/mic-roster.js';

export function micRosterPath(home = homedir()): string {
  return join(home, '.rf-ranger', 'mic-assignments.json');
}

/** A problem with what was submitted, explained for the person at the screen. */
export class RosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterError';
  }
}

const MAX_TEXT = 100;
const MAX_ROLES = 100;
const MAX_MICS = 64;
const MAX_PREFS = 32;

interface Events {
  change: [];
}

/** Sync on its own this long before each service's first rehearsal or service time. */
export interface AutoSyncSetting {
  leadMinutes: number;
}

interface State {
  rules: MicRules;
  roster: Roster;
  autoSync?: AutoSyncSetting;
}

const MAX_LEAD_MINUTES = 7 * 24 * 60;

export class MicRosterStore extends EventEmitter<Events> {
  private state: State = { rules: EMPTY_RULES, roster: EMPTY_ROSTER };

  /** Without a path, everything lives in memory only (tests, demo). */
  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    super();
    if (path) this.state = load(path);
  }

  rules(): MicRules {
    return this.state.rules;
  }

  roster(): Roster {
    return this.state.roster;
  }

  autoSync(): AutoSyncSetting | undefined {
    return this.state.autoSync;
  }

  /** `null` turns the scheduled sync off. */
  setAutoSync(input: unknown): AutoSyncSetting | undefined {
    if (input === null || input === undefined) {
      this.state = { ...this.state, autoSync: undefined };
    } else {
      const lead = Number((input as { leadMinutes?: unknown }).leadMinutes);
      if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_MINUTES) throw new RosterError('Choose how long before the service to sync.');
      this.state = { ...this.state, autoSync: { leadMinutes: lead } };
    }
    this.persist();
    return this.state.autoSync;
  }

  setRules(input: unknown): MicRules {
    this.state = { ...this.state, rules: cleanRules(input) };
    this.persist();
    return this.state.rules;
  }

  /** Replace the roster with the rules applied to this plan. Changes made by hand are discarded. */
  sync(plan: Roster['plan'], scheduled: RosterPerson[]): Roster {
    const teams = new Set(this.state.rules.teamIds);
    const people = scheduled.filter((p) => teams.has(p.teamId) && p.status !== 'declined');
    this.state = { ...this.state, roster: { plan, syncedAt: this.now(), people, ...assignMics(scheduled, this.state.rules) } };
    this.persist();
    return this.state.roster;
  }

  /**
   * Put someone on a mic by hand: a person from the last sync (`personId`),
   * or anyone by name. Whoever had that person before loses them, so nobody
   * is on two mics. `null` empties the mic.
   */
  assign(mic: string, input: { personId?: unknown; name?: unknown; role?: unknown } | null): Roster {
    if (typeof mic !== 'string' || !mic || mic.length > 200) throw new RosterError('Choose a mic.');
    const entries = { ...this.state.roster.entries };
    const displaced = entries[mic];
    if (input === null) {
      delete entries[mic];
    } else {
      let entry: RosterEntry;
      if (typeof input.personId === 'string' && input.personId) {
        const p = this.state.roster.people.find((x) => x.personId === input.personId);
        if (!p) throw new RosterError('That person isn’t on the schedule from the last sync. Sync again, or type their name.');
        entry = { name: p.name, role: p.position || undefined, personId: p.personId, photoUrl: p.photoUrl, unconfirmed: p.status === 'unconfirmed' || undefined, source: 'manual' };
        for (const [k, e] of Object.entries(entries)) if (e.personId === p.personId) delete entries[k];
      } else {
        const name = text(input.name);
        if (!name) throw new RosterError('Enter a name.');
        entry = { name, role: text(input.role) || undefined, source: 'manual' };
      }
      entries[mic] = entry;
    }
    const placed = new Set(Object.values(entries).map((e) => e.personId).filter(Boolean));
    const unplaced = this.state.roster.unplaced.filter((u) => !placed.has(u.personId));
    // Whoever was on this mic and now has none is listed, so nobody drops off silently.
    if (displaced?.personId && !placed.has(displaced.personId) && !unplaced.some((u) => u.personId === displaced.personId)) {
      unplaced.push({ personId: displaced.personId, name: displaced.name, role: displaced.role ?? '', reason: 'removed' });
    }
    this.state = { ...this.state, roster: { ...this.state.roster, entries, unplaced } };
    this.persist();
    return this.state.roster;
  }

  /** Empty every mic (e.g. after the service). The rules stay. */
  clear(): Roster {
    this.state = { ...this.state, roster: EMPTY_ROSTER };
    this.persist();
    return this.state.roster;
  }

  private persist(): void {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, ...this.state }, null, 2) + '\n');
      renameSync(tmp, this.path);
    }
    this.emit('change');
  }
}

function load(path: string): State {
  let raw: { rules?: unknown; roster?: Partial<Roster>; autoSync?: { leadMinutes?: unknown } };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as typeof raw;
  } catch {
    return { rules: EMPTY_RULES, roster: EMPTY_ROSTER };
  }
  let rules = EMPTY_RULES;
  try {
    rules = cleanRules(raw.rules);
  } catch {
    // keep the roster even if the rules are damaged
  }
  const r = raw.roster;
  const roster: Roster = r && typeof r === 'object' && r.entries && typeof r.entries === 'object'
    ? { plan: r.plan, syncedAt: r.syncedAt, entries: r.entries, unplaced: Array.isArray(r.unplaced) ? r.unplaced : [], people: Array.isArray(r.people) ? r.people : [] }
    : EMPTY_ROSTER;
  const lead = Number(raw.autoSync?.leadMinutes);
  const autoSync = Number.isInteger(lead) && lead >= 0 && lead <= MAX_LEAD_MINUTES ? { leadMinutes: lead } : undefined;
  return { rules, roster, autoSync };
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) : '';
}

function ids(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(0, max);
}

function cleanRules(v: unknown): MicRules {
  if (!v || typeof v !== 'object') throw new RosterError('Mic rules are in the wrong format.');
  const o = v as Record<string, unknown>;
  const roles = (Array.isArray(o.roles) ? o.roles : []).slice(0, MAX_ROLES).flatMap((r): MicRules['roles'] => {
    if (!r || typeof r !== 'object') return [];
    const x = r as Record<string, unknown>;
    const teamId = text(x.teamId);
    const position = text(x.position);
    if (!teamId || !position) return [];
    const mics = ids(x.mics, MAX_MICS);
    const prefer = (Array.isArray(x.prefer) ? x.prefer : []).slice(0, MAX_PREFS).flatMap((p) => {
      const y = (p ?? {}) as Record<string, unknown>;
      const personId = text(y.personId);
      const mic = typeof y.mic === 'string' ? y.mic : '';
      return personId && mics.includes(mic) ? [{ personId, name: text(y.name) || personId, mic }] : [];
    });
    return [{ teamId, position, mics, prefer }];
  });
  return { teamIds: ids(o.teamIds, 20), roles };
}
