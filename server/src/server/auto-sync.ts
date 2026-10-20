/**
 * Scheduled "Sync from Planning Center": once per service, a set time before
 * its first rehearsal or service time. A tech can then fix anything at the
 * rehearsal and the changes stay for the service: a service that has already
 * been synced (by hand or automatically) is never synced again on its own.
 */
import type { AutoSyncInfo, RosterPerson } from '../core/mic-roster.js';
import type { PlanningCenterLink } from '../integrations/planning-center/link.js';
import type { MicRosterStore } from './mic-roster-store.js';

export type { AutoSyncInfo } from '../core/mic-roster.js';

/** Apply the mic rules to the upcoming plan. Shared by the Sync button and the schedule. */
export async function syncFromPlanningCenter(link: PlanningCenterLink, store: MicRosterStore, now = Date.now()): Promise<boolean> {
  const { plan, people } = await link.schedule(now);
  if (!plan) return false;
  const scheduled: RosterPerson[] = people.map((p) => ({
    personId: p.personId, name: p.name, teamId: p.teamId, position: p.position, status: p.status, photoUrl: p.photoUrl,
  }));
  store.sync({ id: plan.id, dates: plan.dates, title: plan.title }, scheduled);
  return true;
}

export class AutoSync {
  private timer: NodeJS.Timeout | undefined;
  private state: Omit<AutoSyncInfo, 'leadMinutes'> = {};
  private inflight: Promise<void> | undefined;
  private queued: Promise<void> | undefined;

  constructor(
    private readonly link: PlanningCenterLink,
    private readonly store: MicRosterStore,
    private readonly opts: { log?: (m: string) => void; intervalMs?: number; now?: () => number } = {},
  ) {
    // A changed setting is checked right away rather than at the next tick.
    store.on('change', () => void this.tick());
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 120_000);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  info(): AutoSyncInfo {
    const lead = this.store.autoSync()?.leadMinutes;
    return lead === undefined ? {} : { leadMinutes: lead, ...this.state };
  }

  /**
   * Check the schedule now. While a check is under way, one more is queued to
   * run after it (it may have started before whatever changed), never more.
   */
  tick(): Promise<void> {
    if (this.inflight) {
      this.queued ??= this.inflight.then(() => {
        this.queued = undefined;
        return this.tick();
      });
      return this.queued;
    }
    this.inflight = this.check().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async check(): Promise<void> {
    const auto = this.store.autoSync();
    if (!auto) {
      this.state = {};
      return;
    }
    if (!this.link.status().configured || !this.store.rules().teamIds.length) return;
    const now = this.opts.now?.() ?? Date.now();
    try {
      const plan = await this.link.nextPlan(now);
      if (!plan) {
        this.state = { checkedAt: now };
        return;
      }
      const starts = plan.times.map((t) => Date.parse(t.startsAt)).filter(Number.isFinite);
      if (!starts.length) {
        this.state = { checkedAt: now, error: `${plan.dates} has no rehearsal or service times in Planning Center.` };
        return;
      }
      if (this.store.roster().plan?.id === plan.id) {
        this.state = { checkedAt: now, done: { planDates: plan.dates } };
        return;
      }
      const at = Math.min(...starts) - auto.leadMinutes * 60_000;
      if (now < at) {
        this.state = { checkedAt: now, next: { at, planDates: plan.dates } };
        return;
      }
      await syncFromPlanningCenter(this.link, this.store, now);
      this.opts.log?.(`Planning Center: mics synced automatically for ${plan.dates}`);
      this.state = { checkedAt: now, done: { planDates: plan.dates } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.state = { ...this.state, checkedAt: now, error: message };
      this.opts.log?.(`Planning Center automatic mic sync failed: ${message}`);
    }
  }
}
