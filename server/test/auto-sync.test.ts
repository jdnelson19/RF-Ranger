import { describe, expect, it } from 'vitest';
import type { PlanningCenterLink } from '../src/integrations/planning-center/link.js';
import type { Plan, ScheduledPerson } from '../src/integrations/planning-center/services.js';
import { AutoSync } from '../src/server/auto-sync.js';
import { MicRosterStore } from '../src/server/mic-roster-store.js';

const H = 3_600_000;
const REHEARSAL = Date.parse('2026-10-25T13:00:00Z');
const planFor = (id: string, first: number): Plan => ({
  id, serviceTypeId: 'st', dates: `Plan ${id}`, sortDate: '2026-10-25',
  times: [
    { id: 't1', kind: 'rehearsal', startsAt: new Date(first).toISOString(), endsAt: new Date(first + H).toISOString() },
    { id: 't2', kind: 'service', startsAt: new Date(first + 2 * H).toISOString(), endsAt: new Date(first + 3 * H).toISOString() },
  ],
});
const people: ScheduledPerson[] = [
  { personId: 'p1', name: 'Person One', teamId: 'vocals', team: 'Vocals', position: 'Worship Leader', index: 1, status: 'confirmed' },
];
const rules = (mic: string) => ({ teamIds: ['vocals'], roles: [{ teamId: 'vocals', position: 'Worship Leader', mics: [mic], prefer: [] }] });

function setup(plans: Record<string, Plan> = { '100': planFor('plan-1', REHEARSAL) }) {
  const syncs: string[] = [];
  const link = {
    status: () => ({ configured: true, connected: true }),
    nextPlan: async (st: string) => plans[st],
    // One person per service type, so services don't compete for the same person.
    schedule: async (st: string) => { syncs.push(st); return { plan: plans[st], people: people.map((p) => ({ ...p, personId: `${p.personId}-${st}` })) }; },
  } as unknown as PlanningCenterLink;
  let now = REHEARSAL - 5 * H;
  const store = new MicRosterStore(undefined, () => now);
  const auto = new AutoSync(link, store, { now: () => now });
  const service = (st: string, mic = 'rx/1') => {
    const id = store.addService({ serviceTypeId: st, name: `Service ${st}` }).id;
    store.setRules(id, rules(mic));
    return id;
  };
  return { store, auto, syncs, service, at: (t: number) => { now = t; } };
}

describe('AutoSync', () => {
  it('does nothing for a service without a schedule', async () => {
    const t = setup();
    t.service('100');
    await t.auto.tick();
    expect(t.syncs).toEqual([]);
    expect(t.auto.info()).toEqual({});
  });

  it('before: syncs once, the set time before the first rehearsal, then leaves later changes alone', async () => {
    const t = setup();
    const id = t.service('100');
    t.store.setAutoSync(id, { kind: 'before', leadMinutes: 120 });
    await t.auto.tick();
    expect(t.syncs).toEqual([]);
    expect(t.auto.info()[id]).toMatchObject({ next: { at: REHEARSAL - 2 * H, planDates: 'Plan plan-1' } });

    t.at(REHEARSAL - 2 * H);
    await t.auto.tick();
    expect(t.syncs).toEqual(['100']);
    expect(t.store.roster().synced[id]).toMatchObject({ automatic: true, plan: { id: 'plan-1' } });
    expect(t.auto.info()[id]).toMatchObject({ done: { planDates: 'Plan plan-1' } });

    // The tech fixes something at rehearsal; it survives every later check.
    t.store.assign('rx/1', { name: 'Stand-in' });
    t.at(REHEARSAL + 90 * 60_000);
    await t.auto.tick();
    expect(t.syncs).toEqual(['100']);
    expect(t.store.roster().entries['rx/1']!.name).toBe('Stand-in');
  });

  it('before: never re-syncs a plan that was already synced by hand', async () => {
    const t = setup();
    const id = t.service('100');
    t.store.sync(id, { id: 'plan-1', dates: 'Plan plan-1' }, []);
    t.store.setAutoSync(id, { kind: 'before', leadMinutes: 60 });
    t.at(REHEARSAL);
    await t.auto.tick();
    expect(t.syncs).toEqual([]);
    expect(t.auto.info()[id]!.done).toEqual({ planDates: 'Plan plan-1' });
  });

  it('weekly: runs at its time once a week, not when first set after the time passed', async () => {
    const t = setup();
    const id = t.service('100');
    const wed5pm = new Date(2026, 9, 21, 17, 0).getTime(); // a Wednesday, local time
    t.at(wed5pm + H); // the user sets "Wednesdays 5 PM" at 6 PM: no sync today
    t.store.setAutoSync(id, { kind: 'weekly', day: 3, time: '17:00' });
    await t.auto.tick();
    expect(t.syncs).toEqual([]);
    expect(t.auto.info()[id]!.next!.at).toBe(new Date(2026, 9, 28, 17, 0).getTime());

    t.at(new Date(2026, 9, 28, 17, 1).getTime());
    await t.auto.tick();
    await t.auto.tick();
    expect(t.syncs).toEqual(['100']); // once, however many checks
    t.at(new Date(2026, 10, 4, 17, 0).getTime() + 5 * H); // closed at 5 PM, opened at 10 PM: still runs
    await t.auto.tick();
    expect(t.syncs).toEqual(['100', '100']);
  });

  it('runs several services through the week, each from its own plans', async () => {
    const t = setup({ '100': planFor('weekend', REHEARSAL), '200': planFor('youth', REHEARSAL + 30 * H) });
    const weekend = t.service('100', 'rx/1');
    const youth = t.service('200', 'rx/2');
    t.store.setAutoSync(weekend, { kind: 'before', leadMinutes: 60 });
    t.store.setAutoSync(youth, { kind: 'before', leadMinutes: 60 });
    t.at(REHEARSAL);
    await t.auto.tick();
    expect(t.syncs).toEqual(['100']);
    t.at(REHEARSAL + 30 * H);
    await t.auto.tick();
    expect(t.syncs).toEqual(['100', '200']);
    // Each sync replaces the roster: the youth sync leaves only its own mic.
    expect(Object.keys(t.store.roster().entries).sort()).toEqual(['rx/2']);
  });

  it('refuses a nonsense lead time', () => {
    const t = setup();
    const id = t.service('100');
    expect(() => t.store.setAutoSync(id, { kind: 'before', leadMinutes: -5 })).toThrow(/how long before/);
  });
});
