/**
 * Planning Center Services: service types, the next plan, who is scheduled
 * in it, and its live (Services Live) state. Each fetch is paired with a pure
 * parser so the response handling is testable without the network.
 *
 * Endpoints and field use follow Planning Center's API docs, cross-checked
 * against bitfocus companion-module-planningcenter-serviceslive (MIT,
 * (c) 2018-2023 Joseph Adams).
 */
import type { PcoClient, PcoDocument, PcoResource } from './client.js';
import type { Organization, ServiceType, Team, TeamPerson } from './types.js';

export type { Organization, ServiceType, Team, TeamPerson } from './types.js';

const SERVICES = '/services/v2';


export interface PlanTime {
  id: string;
  startsAt: string;
  endsAt: string;
  kind: 'service' | 'rehearsal' | 'other';
}

export interface Plan {
  id: string;
  serviceTypeId: string;
  title?: string;
  seriesTitle?: string;
  /** Planning Center's display string, e.g. "October 18, 2026". */
  dates: string;
  sortDate: string;
  times: PlanTime[];
}

export type ScheduleStatus = 'confirmed' | 'unconfirmed' | 'declined';

/** One person in one position on a plan. */
export interface ScheduledPerson {
  personId: string;
  name: string;
  teamId: string;
  team: string;
  position: string;
  /**
   * 1-based among people in the same team and position, in Planning Center's
   * order: the second "BGV" is index 2. This is what slot mappings key on.
   */
  index: number;
  status: ScheduleStatus;
  photoUrl?: string;
}

export interface LiveItem {
  title: string;
  lengthSec: number;
}

export interface LiveState {
  planTitle?: string;
  state: 'not-started' | 'running' | 'ended';
  /** Present while running. `id` is the plan item's, for looking up its notes (e.g. its leader). */
  current?: LiveItem & { id: string; startedAt: string; endsAt: string };
  /** The next non-header item. */
  next?: LiveItem;
}

// ---- fetches -------------------------------------------------------------

/**
 * The organization the credentials belong to. Only name and time zone are
 * kept: the full resource includes account details (even a `secret`).
 */
export async function organization(client: PcoClient): Promise<Organization> {
  const doc = await client.get<PcoResource<{ name?: string; time_zone?: string }>>(SERVICES);
  return { id: doc.data.id, name: doc.data.attributes.name ?? 'Planning Center', timeZone: doc.data.attributes.time_zone || undefined };
}

export async function serviceTypes(client: PcoClient): Promise<ServiceType[]> {
  const doc = await client.getAll<{ name: string }>(`${SERVICES}/service_types`, { order: 'sequence' });
  return doc.data.map((r) => ({ id: r.id, name: r.attributes.name }));
}

/**
 * The plan to prepare for: the earliest future plan whose last service time
 * hasn't ended yet. Once a service ends, this moves on to the next one.
 */
export async function upcomingPlan(client: PcoClient, serviceTypeId: string, now = Date.now()): Promise<Plan | undefined> {
  const doc = await client.get<PcoResource[]>(`${SERVICES}/service_types/${serviceTypeId}/plans`, {
    filter: 'future',
    order: 'sort_date',
    per_page: 5,
    include: 'plan_times',
  });
  return pickUpcoming(parsePlans(doc, serviceTypeId), now);
}

export async function scheduledPeople(client: PcoClient, serviceTypeId: string, planId: string): Promise<ScheduledPerson[]> {
  const doc = await client.getAll(`${SERVICES}/service_types/${serviceTypeId}/plans/${planId}/team_members`, { include: 'team' });
  return parseTeamMembers(doc);
}

/** The service type's teams and each one's positions (Worship Leader, BGV 1, …), scheduled or not. */
export async function teams(client: PcoClient, serviceTypeId: string): Promise<Team[]> {
  const doc = await client.getAll(`${SERVICES}/service_types/${serviceTypeId}/teams`, { include: 'team_positions' });
  return parseTeams(doc);
}

/** Everyone on a team, for choosing who prefers which mic. Archived people are left out. */
export async function teamPeople(client: PcoClient, teamId: string): Promise<TeamPerson[]> {
  const doc = await client.getAll(`${SERVICES}/teams/${teamId}/people`, {});
  return parseTeamPeople(doc);
}

/**
 * Each item's leader on a plan: the text of its item note in a "Leader"
 * category (e.g. "Sam/BGVs/Band" or "Pastor Alex Morgan"), by item id.
 */
export async function itemLeaders(client: PcoClient, serviceTypeId: string, planId: string): Promise<Record<string, string>> {
  const doc = await client.getAll(`${SERVICES}/service_types/${serviceTypeId}/plans/${planId}/items`, { include: 'item_notes' });
  return parseItemLeaders(doc);
}

export async function liveState(client: PcoClient, serviceTypeId: string, planId: string): Promise<LiveState> {
  const doc = await client.get<PcoResource>(`${SERVICES}/service_types/${serviceTypeId}/plans/${planId}/live`, {
    include: 'items,current_item_time',
  });
  return parseLive(doc);
}

// ---- parsers -------------------------------------------------------------

type PlanAttrs = { title?: string | null; series_title?: string | null; dates: string; sort_date: string };
type PlanTimeAttrs = { starts_at: string; ends_at: string; time_type: string };

export function parsePlans(doc: PcoDocument<PcoResource[]>, serviceTypeId: string): Plan[] {
  const times = new Map((doc.included ?? []).filter((r) => r.type === 'PlanTime').map((r) => [r.id, r as PcoResource<PlanTimeAttrs>]));
  return doc.data.map((r) => {
    const a = r.attributes as PlanAttrs;
    const refs = r.relationships?.plan_times?.data;
    const planTimes = (Array.isArray(refs) ? refs : [])
      .map((ref) => times.get(ref.id))
      .filter((t): t is PcoResource<PlanTimeAttrs> => !!t)
      .map((t) => ({
        id: t.id,
        startsAt: t.attributes.starts_at,
        endsAt: t.attributes.ends_at,
        kind: (['service', 'rehearsal'].includes(t.attributes.time_type) ? t.attributes.time_type : 'other') as PlanTime['kind'],
      }))
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    return {
      id: r.id,
      serviceTypeId,
      title: a.title || undefined,
      seriesTitle: a.series_title || undefined,
      dates: a.dates,
      sortDate: a.sort_date,
      times: planTimes,
    };
  });
}

/** When the plan's last service time ends; undefined if it has none. */
export function planEndsAt(plan: Plan): number | undefined {
  const ends = plan.times.filter((t) => t.kind === 'service').map((t) => Date.parse(t.endsAt)).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : undefined;
}

export function pickUpcoming(plans: Plan[], now: number): Plan | undefined {
  return [...plans]
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate))
    .find((p) => {
      const end = planEndsAt(p);
      return end === undefined || end > now;
    });
}

const STATUS: Record<string, ScheduleStatus> = { C: 'confirmed', U: 'unconfirmed', D: 'declined' };

type TeamMemberAttrs = { name: string; team_position_name: string | null; status: string; photo_thumbnail?: string | null };

export function parseTeamMembers(doc: PcoDocument<PcoResource[]>): ScheduledPerson[] {
  const teams = new Map((doc.included ?? []).filter((r) => r.type === 'Team').map((r) => [r.id, String(r.attributes.name ?? '')]));
  const counters = new Map<string, number>();
  return doc.data.map((r) => {
    const a = r.attributes as TeamMemberAttrs;
    const teamRef = r.relationships?.team?.data;
    const personRef = r.relationships?.person?.data;
    const team = (teamRef && !Array.isArray(teamRef) && teams.get(teamRef.id)) || '';
    const position = a.team_position_name ?? '';
    const key = `${team}\u0000${position}`.toLowerCase();
    const index = (counters.get(key) ?? 0) + 1;
    counters.set(key, index);
    return {
      personId: personRef && !Array.isArray(personRef) ? personRef.id : r.id,
      name: a.name,
      teamId: teamRef && !Array.isArray(teamRef) ? teamRef.id : '',
      team,
      position,
      index,
      status: STATUS[a.status] ?? 'unconfirmed',
      photoUrl: a.photo_thumbnail || undefined,
    };
  });
}

export function parseTeams(doc: PcoDocument<PcoResource[]>): Team[] {
  const positions = new Map((doc.included ?? []).filter((r) => r.type === 'TeamPosition').map((r) => [r.id, String(r.attributes.name ?? '')]));
  return doc.data.map((t) => {
    const refs = t.relationships?.team_positions?.data;
    return {
      id: t.id,
      name: String(t.attributes.name ?? ''),
      positions: (Array.isArray(refs) ? refs : []).map((r) => positions.get(r.id)).filter((p): p is string => !!p),
    };
  });
}

type PersonAttrs = { full_name?: string | null; first_name?: string | null; last_name?: string | null; photo_thumbnail_url?: string | null; archived?: boolean };

export function parseTeamPeople(doc: PcoDocument<PcoResource[]>): TeamPerson[] {
  return doc.data
    .filter((r) => !(r.attributes as PersonAttrs).archived)
    .map((r) => {
      const a = r.attributes as PersonAttrs;
      return { id: r.id, name: a.full_name || [a.first_name, a.last_name].filter(Boolean).join(' '), photoUrl: a.photo_thumbnail_url || undefined };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
}

export function parseItemLeaders(doc: PcoDocument<PcoResource[]>): Record<string, string> {
  const notes = new Map((doc.included ?? []).filter((r) => r.type === 'ItemNote').map((r) => [r.id, r.attributes as { category_name?: string; content?: string }]));
  const out: Record<string, string> = {};
  for (const item of doc.data) {
    const refs = item.relationships?.item_notes?.data;
    for (const ref of Array.isArray(refs) ? refs : []) {
      const note = notes.get(ref.id);
      const text = note?.content?.trim();
      if (text && /leader/i.test(note?.category_name ?? '')) out[item.id] = text;
    }
  }
  return out;
}

type ItemAttrs = { title: string; length: number | null; item_type: string };
type ItemTimeAttrs = { live_start_at: string | null };

export function parseLive(doc: PcoDocument<PcoResource>): LiveState {
  const included = doc.included ?? [];
  const items = included.filter((r): r is PcoResource<ItemAttrs> => r.type === 'Item');
  const planTitle = (doc.data.attributes.title as string | undefined) || undefined;

  const ref = doc.data.relationships?.current_item_time?.data;
  if (!ref || Array.isArray(ref)) {
    return { planTitle, state: 'not-started', next: nextItem(items, -1) };
  }

  // Past the last item, the current item time no longer points at an Item.
  const time = included.find((r) => r.type === 'ItemTime' && r.id === ref.id) as PcoResource<ItemTimeAttrs> | undefined;
  const itemRef = time?.relationships?.item?.data;
  const index = itemRef && !Array.isArray(itemRef) ? items.findIndex((i) => i.id === itemRef.id) : -1;
  const item = items[index];
  if (!time || !item) return { planTitle, state: 'ended' };

  const lengthSec = item.attributes.length ?? 0;
  const startedAt = time.attributes.live_start_at ?? new Date(0).toISOString();
  return {
    planTitle,
    state: 'running',
    current: {
      id: item.id,
      title: item.attributes.title,
      lengthSec,
      startedAt,
      endsAt: new Date(Date.parse(startedAt) + lengthSec * 1_000).toISOString(),
    },
    next: nextItem(items, index),
  };
}

function nextItem(items: PcoResource<ItemAttrs>[], after: number): LiveItem | undefined {
  const n = items.slice(after + 1).find((i) => i.attributes.item_type !== 'header');
  return n && { title: n.attributes.title, lengthSec: n.attributes.length ?? 0 };
}
