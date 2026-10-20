/**
 * Scheduled mic syncs, one schedule per service (see core/mic-roster.ts):
 *
 * - before: a set time before the next plan's first rehearsal or service
 *   time, once per plan. A plan already synced (by hand or automatically) is
 *   never synced again on its own, so changes a tech makes at rehearsal stay.
 * - weekly: at a fixed day and time every week, on this computer's clock.
 *   A time missed while RF Ranger was closed still runs if it's under 12
 *   hours late; each weekly time runs once.
 *
 * Several services can sync through a week, e.g. a multipurpose room used by
 * a weekend service, a youth night and a midweek service.
 */
import { lastWeekly, nextWeekly, type AutoSyncInfo, type RosterPerson, type ServiceSetup } from '../core/mic-roster.js';
import type { PlanningCenterLink } from '../integrations/planning-center/link.js';
import type { MicRosterStore } from './mic-roster-store.js';

export type { AutoSyncInfo } from '../core/mic-roster.js';

const WEEKLY_GRACE_MS = 12 * 3_600_000;

/** Apply a service's rules to its upcoming plan. Shared by the Sync buttons and the schedule. */
export async function syncService(
  link: PlanningCenterLink,
  store: MicRosterStore,
  serviceId: string,
  opts: { now?: number; automatic?: boolean; weeklyDue?: number } = {},
): Promise<string | undefined> {
  const service = store.service(serviceId);
  const { plan, people } = await link.schedule(service.serviceTypeId, opts.now);
  if (!plan) return undefined;
  const scheduled: RosterPerson[] = people.map((p) => ({
    personId: p.personId, name: p.name, teamId: p.teamId, position: p.position, status: p.status, photoUrl: p.photoUrl,
  }));
  store.sync(serviceId, { id: plan.id, dates: plan.dates, title: plan.title }, scheduled, { automatic: opts.automatic, weeklyDue: opts.weeklyDue });
  return plan.dates;
}

export class AutoSync {
  private timer: NodeJS.Timeout | undefined;
  private state: Record<string, AutoSyncInfo> = {};
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
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 60_000);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** By service id; only services with a schedule. */
  info(): Record<string, AutoSyncInfo> {
    return Object.fromEntries(this.store.services().filter((s) => s.autoSync).map((s) => [s.id, this.state[s.id] ?? {}]));
  }

  /**
   * Check every schedule now. While a check is under way, one more is queued
   * to run after it (it may have started before whatever changed), never more.
   */
  tick(): Promise<void> {
    if (this.inflight) {
      this.queued ??= this.inflight.then(() => {
        this.queued = undefined;
        return this.tick();
      });
      return this.queued;
    }
    this.inflight = this.checkAll().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async checkAll(): Promise<void> {
    if (!this.link.status().configured) return;
    for (const service of this.store.services()) {
      if (!service.autoSync) {
        delete this.state[service.id];
        continue;
      }
      if (!service.rules.teamIds.length) {
        this.state[service.id] = { error: 'Choose the teams that get mics first.' };
        continue;
      }
      const now = this.opts.now?.() ?? Date.now();
      try {
        this.state[service.id] = service.autoSync.kind === 'weekly' ? await this.weekly(service, now) : await this.before(service, now);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.state[service.id] = { ...this.state[service.id], checkedAt: now, error: message };
        this.opts.log?.(`Planning Center automatic mic sync failed for ${service.name}: ${message}`);
      }
    }
  }

  private async before(service: ServiceSetup, now: number): Promise<AutoSyncInfo> {
    const rule = service.autoSync as Extract<ServiceSetup['autoSync'], { kind: 'before' }>;
    const plan = await this.link.nextPlan(service.serviceTypeId, now);
    if (!plan) return { checkedAt: now };
    const starts = plan.times.map((t) => Date.parse(t.startsAt)).filter(Number.isFinite);
    if (!starts.length) return { checkedAt: now, error: `${plan.dates} has no rehearsal or service times in Planning Center.` };
    if (this.store.roster().synced[service.id]?.plan.id === plan.id) return { checkedAt: now, done: { planDates: plan.dates } };
    const at = Math.min(...starts) - rule.leadMinutes * 60_000;
    if (now < at) return { checkedAt: now, next: { at, planDates: plan.dates } };
    await syncService(this.link, this.store, service.id, { now, automatic: true });
    this.opts.log?.(`Planning Center: mics synced automatically for ${service.name}, ${plan.dates}`);
    return { checkedAt: now, done: { planDates: plan.dates } };
  }

  private async weekly(service: ServiceSetup, now: number): Promise<AutoSyncInfo> {
    const rule = service.autoSync as Extract<ServiceSetup['autoSync'], { kind: 'weekly' }>;
    const due = lastWeekly(rule, now);
    const late = now - due;
    const ran = this.store.weeklyRun(service.id);
    if (ran !== undefined && ran >= due) return { checkedAt: now, next: { at: nextWeekly(rule, now) } };
    if (late > WEEKLY_GRACE_MS) {
      // Missed by too much (RF Ranger was closed): wait for next week's time.
      return { checkedAt: now, next: { at: nextWeekly(rule, now) } };
    }
    const dates = await syncService(this.link, this.store, service.id, { now, automatic: true, weeklyDue: due });
    if (dates === undefined) this.store.markWeeklyRun(service.id, due); // no upcoming plan: nothing to do this week
    else this.opts.log?.(`Planning Center: mics synced automatically for ${service.name}, ${dates}`);
    return { checkedAt: now, next: { at: nextWeekly(rule, now) }, ...(dates ? { done: { planDates: dates } } : {}) };
  }
}
