/**
 * The running app's link to one church's Planning Center account: connect
 * with a Personal Access Token, check it, pick the service type to follow,
 * disconnect. Each church links its own account from the app; nothing here
 * is shared between installs.
 *
 * The secret never leaves this module: status() reports which account is
 * linked and how, never the token itself.
 */
import { PcoClient, PcoError, type PcoCredentials } from './client.js';
import {
  credentialsPath,
  deleteCredentials,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  settingsPath,
  type PcoSettings,
} from './credentials.js';
import { organization, planEndsAt, scheduledPeople, serviceTypes, upcomingPlan } from './services.js';
import type { Organization, PcoStatus, ServiceType, UpcomingSummary } from './types.js';

export type { PcoStatus, UpcomingSummary } from './types.js';

export interface PlanningCenterLinkOptions {
  credentialsPath?: string;
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export class PlanningCenterLink {
  private readonly credPath: string;
  private readonly setPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl?: typeof fetch;
  private state: Pick<PcoStatus, 'connected' | 'organization' | 'error' | 'checkedAt'> = { connected: false };

  constructor(opts: PlanningCenterLinkOptions = {}) {
    this.credPath = opts.credentialsPath ?? credentialsPath();
    this.setPath = opts.settingsPath ?? settingsPath();
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetch;
  }

  private credentials(): (PcoCredentials & { source: string }) | undefined {
    try {
      return loadCredentials(this.env, this.credPath);
    } catch {
      return undefined;
    }
  }

  private client(c: PcoCredentials): PcoClient {
    return new PcoClient({ credentials: c, fetch: this.fetchImpl });
  }

  private settings(): PcoSettings {
    return loadSettings(this.setPath);
  }

  status(): PcoStatus {
    const c = this.credentials();
    const s = this.settings();
    return {
      configured: !!c,
      source: c ? (c.source === 'environment' ? 'environment' : 'saved') : undefined,
      tokenHint: c ? c.appId.slice(-4) : undefined,
      ...this.state,
      connected: !!c && this.state.connected,
      serviceType: s.serviceTypeId ? { id: s.serviceTypeId, name: s.serviceTypeName } : undefined,
    };
  }

  /** Re-check the stored credentials against Planning Center. */
  async refresh(): Promise<PcoStatus> {
    const c = this.credentials();
    if (!c) {
      this.state = { connected: false };
      return this.status();
    }
    try {
      const org = await organization(this.client(c));
      this.state = { connected: true, organization: org, checkedAt: Date.now() };
      // Credentials replaced outside the app (e.g. by `npm run pco setup`) for another account.
      const s = this.settings();
      if (s.organizationId && s.organizationId !== org.id) saveSettings({ organizationId: org.id }, this.setPath);
    } catch (err) {
      this.state = { connected: false, error: describe(err), checkedAt: Date.now() };
    }
    return this.status();
  }

  /**
   * Check a Personal Access Token and, only if Planning Center accepts it,
   * save it for this user. A rejected token is never written to disk.
   */
  async connect(appId: string, secret: string): Promise<{ status: PcoStatus; serviceTypes: ServiceType[] }> {
    const creds = { appId: appId.trim(), secret: secret.trim() };
    if (!creds.appId || !creds.secret) throw new LinkError('Enter both the Application ID and the Secret.');
    if (this.env.PCO_APP_ID && this.env.PCO_SECRET) {
      throw new LinkError('Planning Center credentials are set by environment variables on this computer; change them there.');
    }
    const client = this.client(creds);
    let org: Organization;
    let types: ServiceType[];
    try {
      org = await organization(client);
      types = await serviceTypes(client);
    } catch (err) {
      throw new LinkError(describe(err));
    }

    saveCredentials(creds, this.credPath);
    // A different account's service type IDs mean nothing here.
    const s = this.settings();
    saveSettings(s.organizationId === org.id ? s : { organizationId: org.id }, this.setPath);
    this.state = { connected: true, organization: org, checkedAt: Date.now() };
    return { status: this.status(), serviceTypes: types };
  }

  disconnect(): PcoStatus {
    const c = this.credentials();
    if (c?.source === 'environment') {
      throw new LinkError('Planning Center credentials are set by environment variables on this computer; remove them there.');
    }
    deleteCredentials(this.credPath);
    saveSettings({}, this.setPath);
    this.state = { connected: false };
    return this.status();
  }

  async serviceTypes(): Promise<ServiceType[]> {
    return serviceTypes(this.requireClient());
  }

  /** Follow a service type; the ID must exist in this account (names repeat). */
  async setServiceType(id: string): Promise<PcoStatus> {
    const types = await this.serviceTypes();
    const type = types.find((t) => t.id === id);
    if (!type) throw new LinkError('That service type is not in this Planning Center account.');
    const orgId = this.state.organization?.id ?? (await organization(this.requireClient())).id;
    saveSettings({ organizationId: orgId, serviceTypeId: type.id, serviceTypeName: type.name }, this.setPath);
    return this.status();
  }

  /** The plan RF Ranger would prepare for now, with a head count, to confirm the setup. */
  async upcoming(now = Date.now()): Promise<UpcomingSummary> {
    const client = this.requireClient();
    const s = this.settings();
    if (!s.serviceTypeId) throw new LinkError('Choose a service type first.');
    const type = { id: s.serviceTypeId, name: s.serviceTypeName ?? s.serviceTypeId };
    const plan = await upcomingPlan(client, type.id, now);
    if (!plan) return { serviceType: type, scheduled: 0, declined: 0, unconfirmed: 0 };
    const people = await scheduledPeople(client, type.id, plan.id);
    const ends = planEndsAt(plan);
    return {
      serviceType: type,
      plan: {
        id: plan.id,
        title: plan.title,
        seriesTitle: plan.seriesTitle,
        dates: plan.dates,
        serviceTimes: plan.times.filter((t) => t.kind === 'service').map((t) => t.startsAt),
        endsAt: ends === undefined ? undefined : new Date(ends).toISOString(),
      },
      scheduled: people.length,
      declined: people.filter((p) => p.status === 'declined').length,
      unconfirmed: people.filter((p) => p.status === 'unconfirmed').length,
    };
  }

  private requireClient(): PcoClient {
    const c = this.credentials();
    if (!c) throw new LinkError('Planning Center is not connected.');
    return this.client(c);
  }
}

/** An error whose message is meant for the person at the screen. */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkError';
  }
}

function describe(err: unknown): string {
  if (err instanceof PcoError) {
    if (err.kind === 'auth') return 'Planning Center rejected this token. Check the Application ID and Secret, or create a new token.';
    if (err.kind === 'forbidden') return "This Planning Center account can't access Services. Ask an administrator for Services access.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
