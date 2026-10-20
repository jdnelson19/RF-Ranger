/**
 * Devices live mode has found before, and their channel names, saved on the
 * RF Ranger computer. At startup they are added straight away, so a receiver
 * that is switched off still has its channels on screen (as offline) and its
 * mics can be given roles and presets; it connects as soon as it answers.
 * "Forget" on the Devices tab removes one for good.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FAMILY_IDS, type DeviceFamilyId } from '../adapters/families.js';

export function knownDevicesPath(home = homedir()): string {
  return join(home, '.rf-ranger', 'known-devices.json');
}

/** The control ports devices use by default: Shure 2202 and 2201 (PSM 1000), Sennheiser SSC 45. */
const STANDARD_PORTS = new Set([2202, 2201, 45]);

/**
 * One key per device: its address, plus the port only when that port is a
 * non-standard one someone chose (e.g. a simulator). A device found by
 * discovery, added by IP, or remembered from before is the same device
 * whichever port it was reached on, so it can't appear twice.
 */
export function deviceKey(host: string, port?: number): string {
  return port === undefined || STANDARD_PORTS.has(port) ? host : `${host}:${port}`;
}

/** A port worth keeping when reconnecting: standard ones are left to the family's default. */
export function customPort(port?: number): number | undefined {
  return port === undefined || STANDARD_PORTS.has(port) ? undefined : port;
}

export interface KnownReceiver {
  id: string;
  host: string;
  port?: number;
  family: DeviceFamilyId;
  channels?: number;
  model?: string;
  /** Channel number → the last name the receiver reported, e.g. "RF1 Sam". */
  names: Record<string, string>;
  lastSeen: number;
}

export interface KnownCharger {
  id: string;
  host: string;
  port?: number;
  model?: string;
  lastSeen: number;
}

const MAX_DEVICES = 200;

export class KnownDevices {
  private receivers: KnownReceiver[] = [];
  private chargers: KnownCharger[] = [];

  /** Without a path, nothing is saved (tests, demo). */
  constructor(private readonly path?: string) {
    if (path) this.load(path);
  }

  list(): { receivers: KnownReceiver[]; chargers: KnownCharger[] } {
    return { receivers: this.receivers, chargers: this.chargers };
  }

  rememberReceiver(r: Omit<KnownReceiver, 'names' | 'lastSeen'>, now = Date.now()): void {
    const key = deviceKey(r.host, r.port);
    const old = this.receivers.find((x) => deviceKey(x.host, x.port) === key);
    const next: KnownReceiver = { ...old, ...r, names: old?.names ?? {}, lastSeen: now };
    this.receivers = [...this.receivers.filter((x) => x !== old), next].slice(-MAX_DEVICES);
    this.save();
  }

  rememberCharger(c: Omit<KnownCharger, 'lastSeen'>, now = Date.now()): void {
    const key = deviceKey(c.host, c.port);
    const old = this.chargers.find((x) => deviceKey(x.host, x.port) === key);
    this.chargers = [...this.chargers.filter((x) => x !== old), { ...old, ...c, lastSeen: now }].slice(-MAX_DEVICES);
    this.save();
  }

  /** The last channel name a receiver reported. */
  name(receiverId: string, channel: number): string | undefined {
    return this.receivers.find((r) => r.id === receiverId)?.names[String(channel)];
  }

  /** Update stored channel names; saves only when something changed. */
  setNames(receiverId: string, names: Record<string, string>): void {
    const r = this.receivers.find((x) => x.id === receiverId);
    if (!r) return;
    const merged = { ...r.names, ...names };
    if (JSON.stringify(merged) === JSON.stringify(r.names)) return;
    r.names = merged;
    this.save();
  }

  /** Remove a device by address; returns whether one was known. */
  forget(host: string): boolean {
    const before = this.receivers.length + this.chargers.length;
    const other = (x: { host: string; port?: number }) => x.host !== host && deviceKey(x.host, x.port) !== host && `${x.host}:${x.port}` !== host;
    this.receivers = this.receivers.filter(other);
    this.chargers = this.chargers.filter(other);
    const changed = this.receivers.length + this.chargers.length !== before;
    if (changed) this.save();
    return changed;
  }

  private load(path: string): void {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { receivers?: unknown[]; chargers?: unknown[] };
      const str = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : undefined);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      this.receivers = (raw.receivers ?? []).flatMap((x): KnownReceiver[] => {
        const o = (x ?? {}) as Record<string, unknown>;
        const id = str(o.id);
        const host = str(o.host);
        const family = str(o.family) as DeviceFamilyId | undefined;
        if (!id || !host || !family || !FAMILY_IDS.includes(family)) return [];
        const names = Object.fromEntries(Object.entries((o.names ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
        return [{ id, host, port: num(o.port), family, channels: num(o.channels), model: str(o.model), names, lastSeen: num(o.lastSeen) ?? 0 }];
      });
      this.chargers = (raw.chargers ?? []).flatMap((x): KnownCharger[] => {
        const o = (x ?? {}) as Record<string, unknown>;
        const id = str(o.id);
        const host = str(o.host);
        return id && host ? [{ id, host, port: num(o.port), model: str(o.model), lastSeen: num(o.lastSeen) ?? 0 }] : [];
      });
      // Earlier versions could save one device twice (with and without its port,
      // the second named "… (2)"). Merge them, so it comes back once.
      const before = this.receivers.length + this.chargers.length;
      this.receivers = dedupe(this.receivers, (keep, all) => ({
        ...keep,
        names: Object.assign({}, ...all.map((x) => x.names).reverse(), keep.names) as Record<string, string>,
      }));
      this.chargers = dedupe(this.chargers, (keep) => keep);
      if (this.receivers.length + this.chargers.length !== before) this.save();
    } catch {
      // nothing remembered yet
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, receivers: this.receivers, chargers: this.chargers }, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}

/**
 * One record per device key. The one kept is the original name (not an
 * auto-numbered "… (2)" copy), so presets and roles stay attached; among
 * equals, the most recently seen. It takes the newest port, model and
 * last-seen time.
 */
function dedupe<T extends { id: string; host: string; port?: number; model?: string; lastSeen: number }>(list: T[], merge: (keep: T, all: T[]) => T): T[] {
  const groups = new Map<string, T[]>();
  for (const x of list) {
    const k = deviceKey(x.host, x.port);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.values()].map((all) => {
    if (all.length === 1) return all[0]!;
    const byRecent = [...all].sort((a, b) => b.lastSeen - a.lastSeen);
    const numbered = (x: T) => /\s\(\d+\)$/.test(x.id);
    const keep = byRecent.find((x) => !numbered(x)) ?? byRecent[0]!;
    const newest = byRecent[0]!;
    return merge({ ...keep, port: newest.port, model: newest.model ?? keep.model, lastSeen: newest.lastSeen }, byRecent);
  });
}
