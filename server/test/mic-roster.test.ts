import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignMics, lastWeekly, nextWeekly, type MicRules, type RosterPerson } from '../src/core/mic-roster.js';
import { MicRosterStore } from '../src/server/mic-roster-store.js';

// Fictional people; team and position names follow a real Planning Center setup.
const VOCALS = 'team-vocals';
const BAND = 'team-band';
const person = (personId: string, position: string, extra: Partial<RosterPerson> = {}): RosterPerson =>
  ({ personId, name: `Person ${personId}`, teamId: VOCALS, position, status: 'confirmed', ...extra });

const rules: MicRules = {
  teamIds: [VOCALS],
  roles: [
    { teamId: VOCALS, position: 'Worship Leader', mics: ['rx/1', 'rx/2', 'rx/3'], prefer: [{ personId: 'avery', name: 'Avery', mic: 'rx/1' }, { personId: 'blake', name: 'Blake', mic: 'rx/2' }] },
    { teamId: VOCALS, position: 'BGV 1', mics: ['rx/5'], prefer: [] },
    { teamId: VOCALS, position: 'BGV 2', mics: ['rx/6'], prefer: [] },
  ],
};

const who = (r: ReturnType<typeof assignMics>) => Object.fromEntries(Object.entries(r.entries).map(([k, v]) => [k, v.personId]));

describe('assignMics', () => {
  it('fills each position onto its own mics, preferences first, others in Planning Center order', () => {
    const r = assignMics([
      person('casey', 'Worship Leader'),
      person('blake', 'Worship Leader'),
      person('avery', 'Worship Leader'),
      person('drew', 'BGV 1'),
      person('emery', 'bgv 2'), // positions match without regard to case
    ], rules);
    expect(who(r)).toEqual({ 'rx/1': 'avery', 'rx/2': 'blake', 'rx/3': 'casey', 'rx/5': 'drew', 'rx/6': 'emery' });
    expect(r.entries['rx/3']).toMatchObject({ name: 'Person casey', role: 'Worship Leader', source: 'planning-center' });
    expect(r.unplaced).toEqual([]);
  });

  it('gives a preferred mic to the next person when the preferred person is not scheduled', () => {
    const r = assignMics([person('casey', 'Worship Leader'), person('blake', 'Worship Leader')], rules);
    expect(who(r)).toEqual({ 'rx/2': 'blake', 'rx/1': 'casey' });
  });

  it('ignores a preference for a mic outside the position', () => {
    const r = assignMics([person('avery', 'BGV 1')], rules);
    expect(who(r)).toEqual({ 'rx/5': 'avery' });
  });

  it('skips declined people and other teams, tags unconfirmed ones, and lists who got no mic', () => {
    const r = assignMics([
      person('avery', 'Worship Leader', { status: 'declined' }),
      person('fin', 'Drums', { teamId: BAND }),
      person('gray', 'BGV 1', { status: 'unconfirmed' }),
      person('hal', 'BGV 1'),
      person('ira', 'BGV Shadow'),
    ], rules);
    expect(who(r)).toEqual({ 'rx/5': 'gray' });
    expect(r.entries['rx/5']!.unconfirmed).toBe(true);
    expect(r.unplaced).toEqual([
      { personId: 'hal', name: 'Person hal', role: 'BGV 1', reason: 'full' },
      { personId: 'ira', name: 'Person ira', role: 'BGV Shadow', reason: 'no-mics' },
    ]);
  });

  it('never puts two people on one mic, even when positions share mics', () => {
    const shared: MicRules = { teamIds: [VOCALS], roles: [
      { teamId: VOCALS, position: 'Worship Leader', mics: ['rx/1'], prefer: [] },
      { teamId: VOCALS, position: 'Vocals', mics: ['rx/1', 'rx/2'], prefer: [] },
    ] };
    const r = assignMics([person('a', 'Worship Leader'), person('b', 'Vocals')], shared);
    expect(who(r)).toEqual({ 'rx/1': 'a', 'rx/2': 'b' });
  });
});

describe('MicRosterStore', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'rf-ranger-mics-')), 'mic-assignments.json');
  const plan = { id: 'plan-1', dates: 'October 25, 2026' };
  const withService = (store: MicRosterStore, serviceTypeId = '100', r: MicRules = rules) => {
    const s = store.addService({ serviceTypeId, name: `Service ${serviceTypeId}` });
    store.setRules(s.id, r);
    return s.id;
  };
  const entries = (store: MicRosterStore) => Object.fromEntries(Object.entries(store.roster().entries).map(([k, v]) => [k, v.personId ?? v.name]));

  it('syncs, takes hand changes without putting anyone on two mics, and keeps it all across a restart', () => {
    const path = tmp();
    const store = new MicRosterStore(path, () => 5000);
    const id = withService(store);
    store.sync(id, plan, [person('avery', 'Worship Leader'), person('casey', 'Worship Leader'), person('hal', 'BGV 3'), person('fin', 'Drums', { teamId: BAND })]);
    expect(entries(store)).toEqual({ 'rx/1': 'avery', 'rx/2': 'casey' });
    const synced = store.roster().synced[id]!;
    expect(synced.people.map((p) => p.personId)).toEqual(['avery', 'casey', 'hal']); // wireless teams only
    expect(synced).toMatchObject({ plan, syncedAt: 5000, unplaced: [{ personId: 'hal', reason: 'no-mics' }] });

    store.assign('rx/3', { personId: 'avery' }); // moves, doesn't copy
    expect(entries(store)).toEqual({ 'rx/2': 'casey', 'rx/3': 'avery' });
    expect(store.roster().entries['rx/3']!.source).toBe('manual');
    store.assign('rx/5', { personId: 'hal' }); // a placed person leaves the "no mic" list
    expect(store.roster().synced[id]!.unplaced).toEqual([]);
    store.assign('rx/6', { name: '  Guest   Speaker ', role: 'Host' });
    expect(store.roster().entries['rx/6']).toEqual({ name: 'Guest Speaker', role: 'Host', source: 'manual' });
    store.assign('rx/2', null); // casey loses her mic, and is listed rather than dropped silently
    expect(store.roster().synced[id]!.unplaced).toEqual([{ personId: 'casey', name: 'Person casey', role: 'Worship Leader', reason: 'removed' }]);
    store.assign('rx/2', { personId: 'casey' });
    expect(store.roster().synced[id]!.unplaced).toEqual([]);
    store.assign('rx/2', null);

    const again = new MicRosterStore(path);
    expect(Object.keys(again.roster().entries).sort()).toEqual(['rx/3', 'rx/5', 'rx/6']);
    expect(again.services()[0]!.rules).toEqual(rules);
    expect(() => again.assign('rx/1', { personId: 'nobody' })).toThrow(/last sync/);
  });

  it('replaces only the syncing service\'s mics, so rooms and services do not overwrite each other', () => {
    const store = new MicRosterStore();
    const weekend = withService(store, '100');
    const youth = withService(store, '200', { teamIds: [VOCALS], roles: [{ teamId: VOCALS, position: 'Worship Leader', mics: ['rx/9'], prefer: [] }] });
    store.sync(weekend, plan, [person('avery', 'Worship Leader')]);
    store.assign('rx/12', { name: 'Guest' }); // nobody's: no sync touches it
    store.sync(youth, { id: 'plan-2', dates: 'Wednesday' }, [person('zoe', 'Worship Leader')]);
    expect(entries(store)).toEqual({ 'rx/1': 'avery', 'rx/9': 'zoe', 'rx/12': 'Guest' });

    // The weekend service syncs again: its mics change, the youth mic and the guest stay.
    store.sync(weekend, { id: 'plan-3', dates: 'Next weekend' }, [person('casey', 'Worship Leader')]);
    expect(entries(store)).toEqual({ 'rx/1': 'casey', 'rx/9': 'zoe', 'rx/12': 'Guest' });
  });

  it('lets a multipurpose room switch over: services sharing mics take them in turn', () => {
    const store = new MicRosterStore();
    const a = withService(store, '100');
    const b = withService(store, '200'); // same rules, same mics
    store.sync(a, plan, [person('avery', 'Worship Leader'), person('casey', 'Worship Leader')]);
    store.sync(b, { id: 'plan-2', dates: 'Wednesday' }, [person('zoe', 'Worship Leader')]);
    expect(entries(store)).toEqual({ 'rx/1': 'zoe' });
  });

  it('cleans rules and schedules, and refuses a service set up twice', () => {
    const store = new MicRosterStore();
    const id = store.addService({ serviceTypeId: '100', name: 'X' }).id;
    const saved = store.setRules(id, { teamIds: [VOCALS, 7], roles: [
      { teamId: VOCALS, position: 'BGV 1', mics: ['rx/5'], prefer: [{ personId: 'a', name: 'A', mic: 'rx/9' }] },
      { teamId: '', position: 'x', mics: [] },
    ] });
    expect(saved).toEqual({ teamIds: [VOCALS], roles: [{ teamId: VOCALS, position: 'BGV 1', mics: ['rx/5'], prefer: [] }] });
    expect(() => store.addService({ serviceTypeId: '100' })).toThrow(/already/);
    expect(() => store.setAutoSync(id, { kind: 'weekly', day: 9, time: '25:00' })).toThrow(/day and a time/);
    expect(store.setAutoSync(id, { kind: 'weekly', day: 3, time: '7:05' })).toEqual({ kind: 'weekly', day: 3, time: '07:05' });
  });

  it('turns a version 1 file (one set of rules) into the first service, keeping its mics', () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({
      version: 1, rules, autoSync: { leadMinutes: 120 },
      roster: { plan, syncedAt: 1, entries: { 'rx/1': { name: 'A', personId: 'a', source: 'planning-center' } }, unplaced: [], people: [] },
    }));
    const store = new MicRosterStore(path, Date.now, { id: '17852', name: 'Weekend' });
    const [s] = store.services();
    expect(s).toMatchObject({ serviceTypeId: '17852', name: 'Weekend', rules, autoSync: { kind: 'before', leadMinutes: 120 } });
    expect(store.roster().entries['rx/1']).toMatchObject({ personId: 'a', serviceId: s!.id });
    expect(store.roster().synced[s!.id]!.plan).toEqual(plan);
  });
});

describe('weekly times', () => {
  // Built from local dates, so the test holds in any time zone.
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

  it('finds the next and the last weekly time on this computer\'s clock', () => {
    const wed5pm = { day: 3, time: '17:00' }; // Oct 21 2026 is a Wednesday
    expect(nextWeekly(wed5pm, at(2026, 10, 19, 12))).toBe(at(2026, 10, 21, 17));
    expect(nextWeekly(wed5pm, at(2026, 10, 21, 17))).toBe(at(2026, 10, 28, 17)); // strictly after
    expect(lastWeekly(wed5pm, at(2026, 10, 21, 18))).toBe(at(2026, 10, 21, 17));
    expect(lastWeekly(wed5pm, at(2026, 10, 21, 16))).toBe(at(2026, 10, 14, 17));
  });
});
