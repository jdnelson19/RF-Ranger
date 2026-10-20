import { describe, expect, it } from 'vitest';
import type { PlanningCenterLink } from '../src/integrations/planning-center/link.js';
import type { Plan, ScheduledPerson } from '../src/integrations/planning-center/services.js';
import { AutoSync } from '../src/server/auto-sync.js';
import { MicRosterStore } from '../src/server/mic-roster-store.js';

const H = 3_600_000;
const REHEARSAL = Date.parse('2026-10-25T13:00:00Z');
const plan: Plan = {
  id: 'plan-1', serviceTypeId: 'st', dates: 'October 25, 2026', sortDate: '2026-10-25',
  times: [
    { id: 't1', kind: 'rehearsal', startsAt: new Date(REHEARSAL).toISOString(), endsAt: new Date(REHEARSAL + H).toISOString() },
    { id: 't2', kind: 'service', startsAt: new Date(REHEARSAL + 2 * H).toISOString(), endsAt: new Date(REHEARSAL + 3 * H).toISOString() },
  ],
};
const people: ScheduledPerson[] = [
  { personId: 'p1', name: 'Person One', teamId: 'vocals', team: 'Vocals', position: 'Worship Leader', index: 1, status: 'confirmed' },
];

function setup() {
  let syncs = 0;
  const link = {
    status: () => ({ configured: true, connected: true }),
    nextPlan: async () => plan,
    schedule: async () => { syncs++; return { plan, people }; },
  } as unknown as PlanningCenterLink;
  const store = new MicRosterStore();
  store.setRules({ teamIds: ['vocals'], roles: [{ teamId: 'vocals', position: 'Worship Leader', mics: ['rx/1'], prefer: [] }] });
  let now = REHEARSAL - 5 * H;
  const auto = new AutoSync(link, store, { now: () => now });
  return { store, auto, syncs: () => syncs, at: (t: number) => { now = t; } };
}

describe('AutoSync', () => {
  it('does nothing while off', async () => {
    const t = setup();
    await t.auto.tick();
    expect(t.syncs()).toBe(0);
    expect(t.auto.info()).toEqual({});
  });

  it('syncs once, the set time before the first rehearsal, and then leaves later changes alone', async () => {
    const t = setup();
    t.store.setAutoSync({ leadMinutes: 120 });
    await t.auto.tick();
    expect(t.syncs()).toBe(0);
    expect(t.auto.info()).toMatchObject({ leadMinutes: 120, next: { at: REHEARSAL - 2 * H, planDates: 'October 25, 2026' } });

    t.at(REHEARSAL - 2 * H);
    await t.auto.tick();
    expect(t.syncs()).toBe(1);
    expect(t.store.roster().entries['rx/1']).toMatchObject({ personId: 'p1' });
    expect(t.auto.info()).toMatchObject({ done: { planDates: 'October 25, 2026' } });

    // The tech fixes something at rehearsal; it survives every later check.
    t.store.assign('rx/1', { name: 'Stand-in' });
    t.at(REHEARSAL + 90 * 60_000);
    await t.auto.tick();
    expect(t.syncs()).toBe(1);
    expect(t.store.roster().entries['rx/1']!.name).toBe('Stand-in');
  });

  it('never re-syncs a service that was already synced by hand', async () => {
    const t = setup();
    t.store.sync({ id: 'plan-1', dates: 'October 25, 2026' }, []);
    t.store.setAutoSync({ leadMinutes: 60 });
    t.at(REHEARSAL);
    await t.auto.tick();
    expect(t.syncs()).toBe(0);
    expect(t.auto.info().done).toEqual({ planDates: 'October 25, 2026' });
  });

  it('refuses a nonsense lead time', () => {
    const t = setup();
    expect(() => t.store.setAutoSync({ leadMinutes: -5 })).toThrow(/how long before/);
  });
});
