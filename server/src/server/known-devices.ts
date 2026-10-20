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
    const old = this.receivers.find((x) => x.host === r.host && x.port === r.port);
    const next: KnownReceiver = { ...old, ...r, names: old?.names ?? {}, lastSeen: now };
    this.receivers = [...this.receivers.filter((x) => x !== old), next].slice(-MAX_DEVICES);
    this.save();
  }

  rememberCharger(c: Omit<KnownCharger, 'lastSeen'>, now = Date.now()): void {
    const old = this.chargers.find((x) => x.host === c.host && x.port === c.port);
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
    const other = (x: { host: string; port?: number }) => x.host !== host && `${x.host}:${x.port}` !== host;
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
