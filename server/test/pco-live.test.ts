import { describe, expect, it } from 'vitest';
import { leaderNames, namesPerson, pairIems } from '../src/core/live.js';
import type { PlanningCenterLink } from '../src/integrations/planning-center/link.js';
import { parseItemLeaders } from '../src/integrations/planning-center/services.js';
import { LiveWatcher } from '../src/server/live-watch.js';
import { MicRosterStore } from '../src/server/mic-roster-store.js';

describe('Planning Center leader notes', () => {
  it('reads each item\'s Leader note', () => {
    const leaders = parseItemLeaders({
      data: [
        { type: 'Item', id: 'i1', attributes: {}, relationships: { item_notes: { data: [{ type: 'ItemNote', id: 'n1' }, { type: 'ItemNote', id: 'n2' }] } } },
        { type: 'Item', id: 'i2', attributes: {}, relationships: { item_notes: { data: [{ type: 'ItemNote', id: 'n3' }] } } },
      ],
      included: [
        { type: 'ItemNote', id: 'n1', attributes: { category_name: 'Leader', content: 'Sam/BGVs/Band' } },
        { type: 'ItemNote', id: 'n2', attributes: { category_name: 'Production', content: 'GFX: Worship' } },
        { type: 'ItemNote', id: 'n3', attributes: { category_name: 'Production', content: 'Lights' } },
      ],
    });
    expect(leaders).toEqual({ i1: 'Sam/BGVs/Band' });
  });

  it('splits the ways people write several leaders', () => {
    expect(leaderNames('Sam/BGVs/Band')).toEqual(['Sam', 'BGVs', 'Band']);
    expect(leaderNames('Pastor Alex Morgan & Jo')).toEqual(['Pastor Alex Morgan', 'Jo']);
    expect(leaderNames('Lee, Kim and Pat (acoustic)')).toEqual(['Lee', 'Kim', 'Pat']);
  });

  it('matches a full name, a titled name, or a first name nobody else on a mic shares', () => {
    expect(namesPerson('Sam/BGVs/Band', 'Sam Rivera')).toBe(true);
    expect(namesPerson('Pastor Alex Morgan', 'Alex Morgan')).toBe(true);
    expect(namesPerson('alex morgan', 'Alex Morgan')).toBe(true);
    expect(namesPerson('Sam/BGVs/Band', 'Samantha Lee')).toBe(false);
    expect(namesPerson('BGVs/Band', 'Sam Rivera')).toBe(false); // group words name nobody
    // Two people called Sam on mics: "Sam" alone is ambiguous, so neither lights up.
    expect(namesPerson('Sam', 'Sam Rivera', ['Sam Rivera', 'Sam Ortiz'])).toBe(false);
    expect(namesPerson('Sam Ortiz', 'Sam Ortiz', ['Sam Rivera', 'Sam Ortiz'])).toBe(true);
  });
});

describe('LiveWatcher', () => {
  const H = 3_600_000;
  const start = Date.parse('2026-10-25T14:00:00Z');
  const plan = {
    id: 'p1', serviceTypeId: '100', dates: 'October 25', sortDate: '', title: undefined,
    times: [{ id: 't', kind: 'service' as const, startsAt: new Date(start).toISOString(), endsAt: new Date(start + H).toISOString() }],
  };
  const setup = () => {
    let liveCalls = 0;
    const link = {
      status: () => ({ configured: true }),
      nextPlan: async () => plan,
      live: async () => {
        liveCalls++;
        return { state: 'running', current: { id: 'i2', title: 'Greeting', lengthSec: 120, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 120_000).toISOString() }, next: { title: 'Song', lengthSec: 240 } };
      },
      leaders: async () => ({ i2: 'Sam/BGVs/Band' }),
    } as unknown as PlanningCenterLink;
    const store = new MicRosterStore();
    store.addService({ serviceTypeId: '100', name: 'Weekend' });
    let now = start - 2 * H;
    const w = new LiveWatcher(link, store, { now: () => now });
    return { w, calls: () => liveCalls, at: (t: number) => { now = t; } };
  };

  it('stays idle away from the plan\'s times, then reports the live item and its leader', async () => {
    const t = setup();
    expect(await t.w.tick()).toBe(false);
    expect(t.calls()).toBe(0);
    expect(t.w.live()).toBeUndefined();

    t.at(start + 30_000);
    let changed = 0;
    t.w.on('change', () => changed++);
    expect(await t.w.tick()).toBe(true);
    expect(t.w.live()).toEqual({
      serviceName: 'Weekend', planTitle: 'October 25',
      item: { title: 'Greeting', lengthSec: 120, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 120_000).toISOString() },
      next: { title: 'Song', lengthSec: 240 },
      leader: 'Sam/BGVs/Band',
    });
    await t.w.tick();
    expect(changed).toBe(1); // only when something changes
  });
});

describe('pairIems', () => {
  const mic = (key: string, artist: string) => ({ key, role: 'mic', assignment: { artist } });
  const iem = (key: string, artist: string) => ({ key, role: 'iem', assignment: { artist } });

  it('pairs a mic with the IEM channel named for its person', () => {
    const pairs = pairIems([mic('rx/1', 'Sam Lee'), mic('rx/2', 'Alex Kim'), mic('rx/3', 'Jo Park'), iem('p10/1', 'Sam'), iem('p10/2', 'Alex Kim')]);
    expect([...pairs]).toEqual([['rx/1', 'p10/1'], ['rx/2', 'p10/2']]);
  });

  it('shares a mix named for two people, and skips a first name two people share', () => {
    const pairs = pairIems([mic('rx/1', 'Sam Lee'), mic('rx/2', 'Alex Kim'), mic('rx/3', 'Sam Ray'), iem('p10/1', 'Alex/Sam Lee')]);
    expect([...pairs]).toEqual([['rx/1', 'p10/1'], ['rx/2', 'p10/1']]);
  });
});
