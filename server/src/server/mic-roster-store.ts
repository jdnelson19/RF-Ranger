/**
 * The services RF Ranger fills mics from (each a Planning Center service
 * type with its own mic rules and sync schedule) and the current roster (see
 * core/mic-roster.ts). Saved on the RF Ranger computer so a restart keeps the
 * week's assignments and any changes the A1 made by hand.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  EMPTY_ROSTER,
  EMPTY_RULES,
  assignMics,
  lastWeekly,
  rosterPeople,
  type AutoSyncRule,
  type MicRules,
  type Roster,
  type RosterEntry,
  type RosterPerson,
  type ServiceSetup,
  type ServiceSync,
} from '../core/mic-roster.js';

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
const MAX_SERVICES = 20;
const MAX_ROLES = 100;
const MAX_MICS = 64;
const MAX_PREFS = 32;
const MAX_LEAD_MINUTES = 7 * 24 * 60;

interface Events {
  change: [];
}

interface State {
  services: ServiceSetup[];
  roster: Roster;
  /** Service id → the weekly due time it last ran for, so a restart doesn't run it twice. */
  weeklyRuns: Record<string, number>;
}

const EMPTY: State = { services: [], roster: EMPTY_ROSTER, weeklyRuns: {} };

export class MicRosterStore extends EventEmitter<Events> {
  private state: State = EMPTY;

  /**
   * Without a path, everything lives in memory only (tests, demo).
   * `legacyServiceType` names the service type a version 1 file (one set of
   * rules, before services) belonged to, so it becomes the first service.
   */
  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    legacyServiceType?: { id: string; name: string },
  ) {
    super();
    if (path) this.state = load(path, legacyServiceType);
  }

  services(): ServiceSetup[] {
    return this.state.services;
  }

  service(id: string): ServiceSetup {
    const s = this.state.services.find((x) => x.id === id);
    if (!s) throw new RosterError('That service is no longer set up.');
    return s;
  }

  roster(): Roster {
    return this.state.roster;
  }

  weeklyRun(serviceId: string): number | undefined {
    return this.state.weeklyRuns[serviceId];
  }

  addService(input: { serviceTypeId?: unknown; name?: unknown }): ServiceSetup {
    const serviceTypeId = text(input.serviceTypeId);
    if (!/^\d+$/.test(serviceTypeId)) throw new RosterError('Choose a Planning Center service type.');
    if (this.state.services.some((s) => s.serviceTypeId === serviceTypeId)) throw new RosterError('That service is already set up.');
    if (this.state.services.length >= MAX_SERVICES) throw new RosterError(`There's a limit of ${MAX_SERVICES} services.`);
    const service: ServiceSetup = { id: randomUUID(), serviceTypeId, name: text(input.name) || `Service type ${serviceTypeId}`, rules: EMPTY_RULES };
    this.state = { ...this.state, services: [...this.state.services, service] };
    this.persist();
    return service;
  }

  /** Stop following a service. Mics it filled stay until changed or cleared. */
  removeService(id: string): void {
    this.service(id);
    const { [id]: _synced, ...synced } = this.state.roster.synced;
    const { [id]: _run, ...weeklyRuns } = this.state.weeklyRuns;
    this.state = { ...this.state, services: this.state.services.filter((s) => s.id !== id), roster: { ...this.state.roster, synced }, weeklyRuns };
    this.persist();
  }

  setRules(id: string, input: unknown): MicRules {
    return this.updateService(id, { rules: cleanRules(input) }).rules;
  }

  /**
   * `null` turns the scheduled sync off. A new weekly time starts from its
   * next occurrence: one that already passed today doesn't sync right away.
   */
  setAutoSync(id: string, input: unknown): AutoSyncRule | undefined {
    const rule = input === null || input === undefined ? undefined : cleanAutoSync(input);
    if (rule?.kind === 'weekly') this.state = { ...this.state, weeklyRuns: { ...this.state.weeklyRuns, [id]: lastWeekly(rule, this.now()) } };
    return this.updateService(id, { autoSync: rule }).autoSync;
  }

  /**
   * Apply a service's rules to its plan. The sync replaces the whole
   * roster: every mic it doesn't fill is cleared, including people another
   * service's sync put there and hand changes, so nobody from an earlier
   * service is left on a mic. Other services' last syncs stay listed (their
   * people can still be picked by hand).
   */
  sync(id: string, plan: ServiceSync['plan'], scheduled: RosterPerson[], opts: { automatic?: boolean; weeklyDue?: number } = {}): Roster {
    const service = this.service(id);
    const teams = new Set(service.rules.teamIds);
    const people = scheduled.filter((p) => teams.has(p.teamId) && p.status !== 'declined');
    const { entries: fresh, unplaced } = assignMics(scheduled, service.rules);

    const entries: Roster['entries'] = {};
    for (const [mic, e] of Object.entries(fresh)) entries[mic] = { ...e, serviceId: id };

    this.state = {
      ...this.state,
      roster: { entries, synced: { ...this.state.roster.synced, [id]: { plan, syncedAt: this.now(), automatic: opts.automatic || undefined, unplaced, people } } },
      weeklyRuns: opts.weeklyDue === undefined ? this.state.weeklyRuns : { ...this.state.weeklyRuns, [id]: opts.weeklyDue },
    };
    this.persist();
    return this.state.roster;
  }

  /** Record that a weekly sync came due and was handled (synced, or nothing to sync). */
  markWeeklyRun(id: string, due: number): void {
    this.state = { ...this.state, weeklyRuns: { ...this.state.weeklyRuns, [id]: due } };
    this.persist();
  }

  /**
   * Put someone on a mic by hand: a person from any service's last sync
   * (`personId`), or anyone by name. Whoever had that person before loses
   * them, so nobody is on two mics. `null` empties the mic.
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
        const p = rosterPeople(this.state.roster).find((x) => x.personId === input.personId);
        if (!p) throw new RosterError('That person isn’t on the schedule from the last sync. Sync again, or type their name.');
        entry = { name: p.name, role: p.position || undefined, personId: p.personId, photoUrl: p.photoUrl, unconfirmed: p.status === 'unconfirmed' || undefined, source: 'manual' };
        for (const [k, e] of Object.entries(entries)) if (e.personId === p.personId) delete entries[k];
      } else {
        const name = text(input.name);
        if (!name) throw new RosterError('Enter a name.');
        entry = { name, role: text(input.role) || undefined, source: 'manual' };
      }
      // A hand change still belongs to the service that filled the mic, so its next sync can take it back.
      entries[mic] = { ...entry, serviceId: displaced?.serviceId };
    }

    const placed = new Set(Object.values(entries).map((e) => e.personId).filter(Boolean));
    const synced: Roster['synced'] = {};
    for (const [id, s] of Object.entries(this.state.roster.synced)) {
      const unplaced = s.unplaced.filter((u) => !placed.has(u.personId));
      // Whoever was on this mic and now has none is listed, so nobody drops off silently.
      if (displaced?.personId && displaced.serviceId === id && !placed.has(displaced.personId) && !unplaced.some((u) => u.personId === displaced.personId)) {
        unplaced.push({ personId: displaced.personId, name: displaced.name, role: displaced.role ?? '', reason: 'removed' });
      }
      synced[id] = { ...s, unplaced };
    }
    this.state = { ...this.state, roster: { entries, synced } };
    this.persist();
    return this.state.roster;
  }

  /** Empty every mic (e.g. after the service). Services and their rules stay. */
  clear(): Roster {
    this.state = { ...this.state, roster: { entries: {}, synced: {} } };
    this.persist();
    return this.state.roster;
  }

  private updateService(id: string, patch: Partial<ServiceSetup>): ServiceSetup {
    const next = { ...this.service(id), ...patch };
    this.state = { ...this.state, services: this.state.services.map((s) => (s.id === id ? next : s)) };
    this.persist();
    return next;
  }

  private persist(): void {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 2, ...this.state }, null, 2) + '\n');
      renameSync(tmp, this.path);
    }
    this.emit('change');
  }
}

function load(path: string, legacy: { id: string; name: string } | undefined): State {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return EMPTY;
  }
  return raw.version === 2 ? loadV2(raw) : loadV1(raw, legacy);
}

function loadV2(raw: Record<string, unknown>): State {
  const services = (Array.isArray(raw.services) ? raw.services : []).slice(0, MAX_SERVICES).flatMap((s): ServiceSetup[] => {
    const o = (s ?? {}) as Record<string, unknown>;
    const id = text(o.id);
    const serviceTypeId = text(o.serviceTypeId);
    if (!id || !serviceTypeId) return [];
    let rules = EMPTY_RULES;
    let autoSync: AutoSyncRule | undefined;
    try { rules = cleanRules(o.rules); } catch { /* keep the service */ }
    try { autoSync = o.autoSync ? cleanAutoSync(o.autoSync) : undefined; } catch { /* sync by hand */ }
    return [{ id, serviceTypeId, name: text(o.name) || serviceTypeId, rules, autoSync }];
  });
  const r = (raw.roster ?? {}) as Partial<Roster>;
  const roster: Roster = {
    entries: r.entries && typeof r.entries === 'object' ? r.entries : {},
    synced: r.synced && typeof r.synced === 'object' ? r.synced : {},
  };
  const runs = (raw.weeklyRuns ?? {}) as Record<string, unknown>;
  const weeklyRuns = Object.fromEntries(Object.entries(runs).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  return { services, roster, weeklyRuns };
}

/** Version 1: one set of rules and one roster, for the service type chosen in the Planning Center settings. */
function loadV1(raw: Record<string, unknown>, legacy: { id: string; name: string } | undefined): State {
  let rules = EMPTY_RULES;
  try { rules = cleanRules(raw.rules); } catch { /* start over */ }
  const lead = Number((raw.autoSync as { leadMinutes?: unknown } | undefined)?.leadMinutes);
  const autoSync: AutoSyncRule | undefined = Number.isInteger(lead) && lead >= 0 && lead <= MAX_LEAD_MINUTES ? { kind: 'before', leadMinutes: lead } : undefined;
  const hasSetup = rules.teamIds.length > 0 || rules.roles.length > 0;
  if (!legacy || !hasSetup) return EMPTY;

  const id = randomUUID();
  const service: ServiceSetup = { id, serviceTypeId: legacy.id, name: legacy.name, rules, autoSync };
  const r = (raw.roster ?? {}) as { plan?: ServiceSync['plan']; syncedAt?: number; entries?: Record<string, RosterEntry>; unplaced?: ServiceSync['unplaced']; people?: RosterPerson[] };
  const entries = Object.fromEntries(Object.entries(r.entries ?? {}).map(([k, e]) => [k, { ...e, serviceId: id }]));
  const synced: Roster['synced'] = r.plan
    ? { [id]: { plan: r.plan, syncedAt: r.syncedAt ?? 0, unplaced: Array.isArray(r.unplaced) ? r.unplaced : [], people: Array.isArray(r.people) ? r.people : [] } }
    : {};
  return { services: [service], roster: { entries, synced }, weeklyRuns: {} };
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) : '';
}

function ids(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))].slice(0, max);
}

function cleanAutoSync(v: unknown): AutoSyncRule {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.kind === 'weekly') {
    const day = Number(o.day);
    const time = typeof o.time === 'string' ? o.time.trim() : '';
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !m) throw new RosterError('Choose a day and a time for the weekly sync.');
    return { kind: 'weekly', day, time: `${m[1]!.padStart(2, '0')}:${m[2]}` };
  }
  const lead = Number(o.leadMinutes);
  if (!Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_MINUTES) throw new RosterError('Choose how long before the service to sync.');
  return { kind: 'before', leadMinutes: lead };
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
