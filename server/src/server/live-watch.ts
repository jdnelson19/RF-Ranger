/**
 * Watch Planning Center Services Live for the set-up services, so the pickup
 * screen can show the current segment with its clock and the engineer view a
 * live banner, with whoever the item's Leader note names highlighted.
 *
 * Only plans near their times are watched: from 30 minutes before a plan's
 * first rehearsal or service until 30 minutes after its last. Then it reads
 * Services Live every 5 seconds; otherwise it only looks up each service's
 * next plan once a minute. Read-only, like everything Planning Center here.
 */
import { EventEmitter } from 'node:events';
import type { LiveNow } from '../core/live.js';
import type { PlanningCenterLink } from '../integrations/planning-center/link.js';
import type { Plan } from '../integrations/planning-center/services.js';
import type { MicRosterStore } from './mic-roster-store.js';

const ACTIVE_MS = 5_000;
const IDLE_MS = 60_000;
const WINDOW_MS = 30 * 60_000;
const PLAN_TTL_MS = 5 * 60_000;
const LEADERS_TTL_MS = 2 * 60_000;

interface Events {
  change: [];
}

export class LiveWatcher extends EventEmitter<Events> {
  private current: LiveNow | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private plans = new Map<string, { plan: Plan | undefined; at: number }>();
  private leaders = new Map<string, { byItem: Record<string, string>; at: number }>();
  private lastError: string | undefined;

  constructor(
    private readonly link: PlanningCenterLink,
    private readonly store: MicRosterStore,
    private readonly opts: { log?: (m: string) => void; now?: () => number } = {},
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      const active = await this.tick();
      if (!this.stopped) this.timer = setTimeout(() => void loop(), active ? ACTIVE_MS : IDLE_MS);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  live(): LiveNow | undefined {
    return this.current;
  }

  /** One look. Returns whether any plan is near its times (so the next look comes sooner). */
  async tick(): Promise<boolean> {
    const now = this.opts.now?.() ?? Date.now();
    let found: LiveNow | undefined;
    let active = false;
    try {
      if (this.link.status().configured) {
        for (const service of this.store.services()) {
          const plan = await this.plan(service.serviceTypeId, now);
          if (!plan || !near(plan, now)) continue;
          active = true;
          const state = await this.link.live(service.serviceTypeId, plan.id);
          if (state.state !== 'running' || !state.current) continue;
          const leaders = await this.leadersFor(service.serviceTypeId, plan.id, now);
          const { id, ...item } = state.current;
          found = { serviceName: service.name, planTitle: plan.title ?? plan.dates, item, next: state.next, leader: leaders[id] };
          break;
        }
      }
      this.lastError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.lastError) this.opts.log?.(`Planning Center Live: ${message}`);
      this.lastError = message;
      found = this.current; // keep showing the last known item through a brief hiccup
    }
    if (JSON.stringify(found) !== JSON.stringify(this.current)) {
      this.current = found;
      this.emit('change');
    }
    return active;
  }

  private async plan(serviceTypeId: string, now: number): Promise<Plan | undefined> {
    const hit = this.plans.get(serviceTypeId);
    if (hit && now - hit.at < PLAN_TTL_MS && (!hit.plan || now < planEnd(hit.plan) + WINDOW_MS)) return hit.plan;
    const plan = await this.link.nextPlan(serviceTypeId, now);
    this.plans.set(serviceTypeId, { plan, at: now });
    return plan;
  }

  private async leadersFor(serviceTypeId: string, planId: string, now: number): Promise<Record<string, string>> {
    const hit = this.leaders.get(planId);
    if (hit && now - hit.at < LEADERS_TTL_MS) return hit.byItem;
    const byItem = await this.link.leaders(serviceTypeId, planId);
    this.leaders.set(planId, { byItem, at: now });
    return byItem;
  }
}

function times(plan: Plan): { start: number; end: number } | undefined {
  const starts = plan.times.map((t) => Date.parse(t.startsAt)).filter(Number.isFinite);
  const ends = plan.times.map((t) => Date.parse(t.endsAt)).filter(Number.isFinite);
  return starts.length && ends.length ? { start: Math.min(...starts), end: Math.max(...ends) } : undefined;
}

function planEnd(plan: Plan): number {
  return times(plan)?.end ?? Infinity;
}

/** From 30 minutes before the plan's first time to 30 minutes after its last. */
function near(plan: Plan, now: number): boolean {
  const t = times(plan);
  return !!t && now >= t.start - WINDOW_MS && now <= t.end + WINDOW_MS;
}
