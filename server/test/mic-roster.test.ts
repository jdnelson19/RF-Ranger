import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignMics, type MicRules, type RosterPerson } from '../src/core/mic-roster.js';
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

  it('syncs, takes hand changes without putting anyone on two mics, and keeps it all across a restart', () => {
    const path = tmp();
    const store = new MicRosterStore(path, () => 5000);
    store.setRules(rules);
    store.sync(plan, [person('avery', 'Worship Leader'), person('casey', 'Worship Leader'), person('hal', 'BGV 3'), person('fin', 'Drums', { teamId: BAND })]);
    expect(who({ entries: store.roster().entries, unplaced: [] })).toEqual({ 'rx/1': 'avery', 'rx/2': 'casey' });
    expect(store.roster().people.map((p) => p.personId)).toEqual(['avery', 'casey', 'hal']); // wireless teams only
    expect(store.roster()).toMatchObject({ plan, syncedAt: 5000, unplaced: [{ personId: 'hal', reason: 'no-mics' }] });

    store.assign('rx/3', { personId: 'avery' }); // moves, doesn't copy
    expect(who({ entries: store.roster().entries, unplaced: [] })).toEqual({ 'rx/2': 'casey', 'rx/3': 'avery' });
    expect(store.roster().entries['rx/3']!.source).toBe('manual');
    store.assign('rx/5', { personId: 'hal' }); // a placed person leaves the "no mic" list
    expect(store.roster().unplaced).toEqual([]);
    store.assign('rx/6', { name: '  Guest   Speaker ', role: 'Host' });
    expect(store.roster().entries['rx/6']).toEqual({ name: 'Guest Speaker', role: 'Host', source: 'manual' });
    store.assign('rx/2', null); // casey loses her mic, and is listed rather than dropped silently
    expect(store.roster().unplaced).toEqual([{ personId: 'casey', name: 'Person casey', role: 'Worship Leader', reason: 'removed' }]);
    store.assign('rx/2', { personId: 'casey' });
    expect(store.roster().unplaced).toEqual([]);
    store.assign('rx/2', null);

    const again = new MicRosterStore(path);
    expect(Object.keys(again.roster().entries).sort()).toEqual(['rx/3', 'rx/5', 'rx/6']);
    expect(again.rules()).toEqual(rules);
    expect(() => again.assign('rx/1', { personId: 'nobody' })).toThrow(/last sync/);
  });

  it('drops preferences for mics outside their position and malformed roles', () => {
    const store = new MicRosterStore();
    const saved = store.setRules({ teamIds: [VOCALS, 7], roles: [
      { teamId: VOCALS, position: 'BGV 1', mics: ['rx/5'], prefer: [{ personId: 'a', name: 'A', mic: 'rx/9' }] },
      { teamId: '', position: 'x', mics: [] },
    ] });
    expect(saved).toEqual({ teamIds: [VOCALS], roles: [{ teamId: VOCALS, position: 'BGV 1', mics: ['rx/5'], prefer: [] }] });
  });
});
