import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PcoClient, PcoError, type PcoDocument, type PcoResource } from '../src/integrations/planning-center/client.js';
import { loadCredentials, saveCredentials } from '../src/integrations/planning-center/credentials.js';
import { parseLive, parsePlans, parseTeamMembers, parseTeamPeople, parseTeams, pickUpcoming, planEndsAt } from '../src/integrations/planning-center/services.js';

const ref = (type: string, id: string) => ({ data: { type, id } });

function planDoc(): PcoDocument<PcoResource[]> {
  const plan = (id: string, sortDate: string, timeIds: string[]): PcoResource => ({
    type: 'Plan',
    id,
    attributes: { title: id === 'p1' ? 'Week 1' : null, series_title: 'Fall', dates: sortDate.slice(0, 10), sort_date: sortDate },
    relationships: { plan_times: { data: timeIds.map((t) => ({ type: 'PlanTime', id: t })) } },
  });
  const time = (id: string, startsAt: string, endsAt: string, timeType = 'service'): PcoResource => ({
    type: 'PlanTime', id, attributes: { starts_at: startsAt, ends_at: endsAt, time_type: timeType },
  });
  return {
    data: [plan('p2', '2026-10-25T09:00:00Z', ['t3']), plan('p1', '2026-10-18T09:00:00Z', ['t2', 't1', 't0'])],
    included: [
      time('t0', '2026-10-18T07:00:00Z', '2026-10-18T08:00:00Z', 'rehearsal'),
      time('t1', '2026-10-18T09:00:00Z', '2026-10-18T10:15:00Z'),
      time('t2', '2026-10-18T11:00:00Z', '2026-10-18T12:15:00Z'),
      time('t3', '2026-10-25T09:00:00Z', '2026-10-25T10:15:00Z'),
    ],
  };
}

describe('plans', () => {
  const plans = parsePlans(planDoc(), 'st1');

  it('attaches plan times in order and classifies them', () => {
    const p1 = plans.find((p) => p.id === 'p1')!;
    expect(p1.times.map((t) => [t.id, t.kind])).toEqual([['t0', 'rehearsal'], ['t1', 'service'], ['t2', 'service']]);
    expect(p1.title).toBe('Week 1');
    expect(plans.find((p) => p.id === 'p2')!.title).toBeUndefined();
  });

  it('ends a plan at its last service time, ignoring rehearsals', () => {
    expect(planEndsAt(plans.find((p) => p.id === 'p1')!)).toBe(Date.parse('2026-10-18T12:15:00Z'));
  });

  it('stays on a plan until its last service ends, then rolls to the next', () => {
    expect(pickUpcoming(plans, Date.parse('2026-10-18T10:30:00Z'))?.id).toBe('p1'); // between services
    expect(pickUpcoming(plans, Date.parse('2026-10-18T12:16:00Z'))?.id).toBe('p2');
    expect(pickUpcoming(plans, Date.parse('2026-11-01T00:00:00Z'))).toBeUndefined();
  });
});

describe('team members', () => {
  const member = (id: string, name: string, position: string, status: string, team = 'band', photo?: string): PcoResource => ({
    type: 'PlanPerson',
    id,
    attributes: { name, team_position_name: position, status, photo_thumbnail: photo ?? null },
    relationships: { person: ref('Person', `person-${id}`), team: ref('Team', team) },
  });
  const people = parseTeamMembers({
    data: [
      member('1', 'Maya Torres', 'Worship Leader', 'C', 'band', 'https://avatars.example/maya.jpg'),
      member('2', 'Jordan Lee', 'BGV', 'C'),
      member('3', 'Priya Shah', 'BGV', 'U'),
      member('4', 'Sam Okafor', 'BGV', 'D'),
      member('5', 'Alex Kim', 'Camera', 'C', 'tech'),
    ],
    included: [
      { type: 'Team', id: 'band', attributes: { name: 'Band' } },
      { type: 'Team', id: 'tech', attributes: { name: 'Tech' } },
    ],
  });

  it('numbers repeated positions within a team', () => {
    expect(people.filter((p) => p.position === 'BGV').map((p) => [p.name, p.index])).toEqual([['Jordan Lee', 1], ['Priya Shah', 2], ['Sam Okafor', 3]]);
  });

  it('maps status, team, photo and person ID', () => {
    expect(people[0]).toEqual({
      personId: 'person-1', name: 'Maya Torres', teamId: 'band', team: 'Band', position: 'Worship Leader', index: 1, status: 'confirmed', photoUrl: 'https://avatars.example/maya.jpg',
    });
    expect(people.map((p) => p.status)).toEqual(['confirmed', 'confirmed', 'unconfirmed', 'declined', 'confirmed']);
    expect(people[4]!.team).toBe('Tech');
  });
});

describe('teams and team people', () => {
  it('lists each team with its positions in order', () => {
    const teams = parseTeams({
      data: [
        { type: 'Team', id: 'vocals', attributes: { name: 'Vocals' }, relationships: { team_positions: { data: [{ type: 'TeamPosition', id: 'wl' }, { type: 'TeamPosition', id: 'b1' }] } } },
        { type: 'Team', id: 'band', attributes: { name: 'Band' }, relationships: { team_positions: { data: [] } } },
      ],
      included: [
        { type: 'TeamPosition', id: 'b1', attributes: { name: 'BGV 1' } },
        { type: 'TeamPosition', id: 'wl', attributes: { name: 'Worship Leader' } },
      ],
    });
    expect(teams).toEqual([{ id: 'vocals', name: 'Vocals', positions: ['Worship Leader', 'BGV 1'] }, { id: 'band', name: 'Band', positions: [] }]);
  });

  it('lists current team members by name, without archived people', () => {
    const people = parseTeamPeople({
      data: [
        { type: 'Person', id: '2', attributes: { full_name: 'Sam Okafor', photo_thumbnail_url: 'https://avatars.example/s.jpg' } },
        { type: 'Person', id: '1', attributes: { full_name: 'Jordan Lee' } },
        { type: 'Person', id: '3', attributes: { full_name: 'Old Member', archived: true } },
      ],
    });
    expect(people).toEqual([{ id: '1', name: 'Jordan Lee', photoUrl: undefined }, { id: '2', name: 'Sam Okafor', photoUrl: 'https://avatars.example/s.jpg' }]);
  });
});

describe('live', () => {
  const item = (id: string, title: string, length: number, itemType = 'song'): PcoResource => ({
    type: 'Item', id, attributes: { title, length, item_type: itemType },
  });
  const items = [item('i0', 'PRE-SERVICE', 0, 'header'), item('i1', 'Countdown', 300, 'media'), item('i2', 'WORSHIP', 0, 'header'), item('i3', 'Song 1', 240)];
  const live = (current?: string, itemId?: string): PcoDocument<PcoResource> => ({
    data: { type: 'Live', id: 'p1', attributes: { title: 'Week 1' }, relationships: { current_item_time: { data: current ? { type: 'ItemTime', id: current } : null } } },
    included: [
      ...items,
      ...(current ? [{ type: 'ItemTime', id: current, attributes: { live_start_at: '2026-10-18T09:00:00Z' }, relationships: { item: { data: itemId ? { type: 'Item', id: itemId } : null } } }] : []),
    ],
  });

  it('is not started, showing the first real item', () => {
    expect(parseLive(live())).toEqual({ planTitle: 'Week 1', state: 'not-started', next: { title: 'Countdown', lengthSec: 300 } });
  });

  it('times the current item and skips headers for next', () => {
    expect(parseLive(live('it1', 'i1'))).toEqual({
      planTitle: 'Week 1',
      state: 'running',
      current: { title: 'Countdown', lengthSec: 300, startedAt: '2026-10-18T09:00:00Z', endsAt: '2026-10-18T09:05:00.000Z' },
      next: { title: 'Song 1', lengthSec: 240 },
    });
  });

  it('is ended when the current time no longer points at an item', () => {
    expect(parseLive(live('it9', undefined)).state).toBe('ended');
  });
});

describe('PcoClient', () => {
  function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fn = (async (url: URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('Authorization') });
      const r = responses.shift()!;
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  const credentials = { appId: 'app', secret: 'sec' };

  it('authenticates with Basic auth and sends the query', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    await new PcoClient({ credentials, fetch: f.fn }).get('/services/v2/service_types', { per_page: 5 });
    expect(f.calls[0]).toEqual({
      url: 'https://api.planningcenteronline.com/services/v2/service_types?per_page=5',
      auth: `Basic ${Buffer.from('app:sec').toString('base64')}`,
    });
  });

  it('waits out a rate limit and retries', async () => {
    const waits: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { 'Retry-After': '3' } }, { status: 200, body: { data: [] } }]);
    await new PcoClient({ credentials, fetch: f.fn, sleep: async (ms) => { waits.push(ms); } }).get('/x');
    expect(waits).toEqual([3_000]);
    expect(f.calls).toHaveLength(2);
  });

  it('explains bad credentials', async () => {
    const f = fakeFetch([{ status: 401 }]);
    await expect(new PcoClient({ credentials, fetch: f.fn }).get('/x')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reports network failures as PcoError', async () => {
    const fn = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    const err = await new PcoClient({ credentials, fetch: fn }).get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(PcoError);
    expect(err.kind).toBe('network');
  });

  it('gives up on a request that never answers', async () => {
    // Like a network that accepts the connection, then stalls: only the abort signal ends it.
    const fn = ((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const err = await new PcoClient({ credentials, fetch: fn, timeoutMs: 20 }).get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(PcoError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/didn't answer/);
  });

  it('gives up on a response body that stalls', async () => {
    const fn = (async (_url: URL, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const err = await new PcoClient({ credentials, fetch: fn, timeoutMs: 20 }).get('/x').catch((e) => e);
    expect(err.kind).toBe('timeout');
  });

  it('follows pagination and merges included resources', async () => {
    const f = fakeFetch([
      { status: 200, body: { data: [{ type: 'T', id: '1', attributes: {} }], included: [{ type: 'Team', id: 'a', attributes: {} }], links: { next: 'https://api.planningcenteronline.com/x?offset=100' } } },
      { status: 200, body: { data: [{ type: 'T', id: '2', attributes: {} }], included: [{ type: 'Team', id: 'b', attributes: {} }] } },
    ]);
    const doc = await new PcoClient({ credentials, fetch: f.fn }).getAll('/x');
    expect(doc.data.map((d) => d.id)).toEqual(['1', '2']);
    expect(doc.included?.map((d) => d.id)).toEqual(['a', 'b']);
    expect(f.calls[0]!.url).toContain('per_page=100');
  });
});

describe('credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-ranger-pco-'));
  const path = join(dir, 'nested', 'planning-center.json');

  it('prefers environment variables', () => {
    expect(loadCredentials({ PCO_APP_ID: 'a', PCO_SECRET: 's' }, path)).toEqual({ appId: 'a', secret: 's', source: 'environment' });
  });

  it('is undefined when nothing is configured', () => {
    expect(loadCredentials({}, path)).toBeUndefined();
  });

  it('round-trips through the per-user file', () => {
    saveCredentials({ appId: 'app', secret: 'sec' }, path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ appId: 'app', secret: 'sec' });
    expect(loadCredentials({}, path)).toEqual({ appId: 'app', secret: 'sec', source: path });
  });
});
