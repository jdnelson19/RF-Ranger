/**
 * Tell the people running RF Ranger when a newer version is out. Asks
 * rfranger.app (the same feed the website's download buttons use) a minute
 * after startup and every 6 hours. Production networks are often offline:
 * any failure is silent and simply means no notice. Sends nothing but the
 * request itself. RF_RANGER_NO_UPDATE_CHECK=1 turns it off.
 */

import type { UpdateNotice } from './snapshot.js';

export type { UpdateNotice } from './snapshot.js';

export const LATEST_URL = 'https://rfranger.app/api/latest';

interface Latest {
  version?: string;
  notesUrl?: string;
  mac?: { url: string } | null;
  windows?: { url: string } | null;
}

export class UpdateCheck {
  private timers: NodeJS.Timeout[] = [];
  private found: UpdateNotice | undefined;

  constructor(
    private readonly current: string,
    private readonly opts: { fetch?: typeof fetch; platform?: NodeJS.Platform; log?: (m: string) => void; url?: string } = {},
  ) {}

  start(firstAfterMs = 60_000, everyMs = 6 * 3_600_000): void {
    this.timers.push(setTimeout(() => void this.check(), firstAfterMs));
    this.timers.push(setInterval(() => void this.check(), everyMs));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  notice(): UpdateNotice | undefined {
    return this.found;
  }

  async check(): Promise<UpdateNotice | undefined> {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url ?? LATEST_URL, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': `RF-Ranger/${this.current}` },
      });
      if (!res.ok) return this.found;
      const latest = (await res.json()) as Latest;
      if (!latest.version || !isNewer(latest.version, this.current)) {
        this.found = undefined;
        return undefined;
      }
      const platform = this.opts.platform ?? process.platform;
      const asset = platform === 'darwin' ? latest.mac : platform === 'win32' ? latest.windows : undefined;
      const url = asset?.url ?? latest.notesUrl ?? 'https://rfranger.app/#download';
      if (this.found?.version !== latest.version) this.opts.log?.(`RF Ranger ${latest.version} is available (running ${this.current}).`);
      this.found = { version: latest.version, url };
    } catch {
      // offline, filtered or slow: no notice
    }
    return this.found;
  }
}

/** Whether `a` is a later x.y.z version than `b`. Anything unparseable is not newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}
