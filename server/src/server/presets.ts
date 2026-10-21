/**
 * Show presets: named, ordered sets of channels an engineer wants on screen
 * at one point in a service ("Worship": the vocal mics; "Message": pastor and
 * announcement mics). Stored on the RF Ranger computer so every engineer
 * screen shares them and sees changes live (they ride along in snapshots).
 *
 * Channels are identified by slot key (`receiverId/channel`), not slot
 * number: in live mode slot numbers follow discovery order, which can change
 * between runs, while receiver IDs and channels don't.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PresetChannel, ShowPreset } from './snapshot.js';

export type { PresetChannel, ShowPreset } from './snapshot.js';
// Keys for channels not currently present are kept, so a preset survives a receiver being offline.

export const MAX_PRESETS = 50;
/** Name of the preset the Planning Center stars make, until it's renamed. */
const STARRED_NAME = 'Synced mics';
const MAX_NAME = 60;
const MAX_SLOTS = 512;
const MAX_NICKNAME = 40;

export function presetsPath(home = homedir()): string {
  return join(home, '.rf-ranger', 'show-presets.json');
}

/** A problem with what was submitted, explained for the person at the screen. */
export class PresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetError';
  }
}

interface Events {
  change: [];
}

export class PresetStore extends EventEmitter<Events> {
  private presets: ShowPreset[] = [];
  private pickup: string | undefined;

  /** Without a path, presets live in memory only (tests, demo). */
  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    super();
    if (path) ({ presets: this.presets, pickup: this.pickup } = load(path));
  }

  list(): ShowPreset[] {
    return this.presets;
  }

  /**
   * The preset the pickup display shows (`#/pickup` without its own preset),
   * set from the engineer view; undefined shows every channel.
   */
  pickupPreset(): string | undefined {
    return this.pickup;
  }

  setPickupPreset(id: unknown): string | undefined {
    if (id === null || id === undefined || id === '') {
      this.pickup = undefined;
    } else {
      if (typeof id !== 'string' || !this.presets.some((p) => p.id === id)) throw new PresetError('That preset no longer exists.');
      this.pickup = id;
    }
    this.persist();
    return this.pickup;
  }

  create(input: { name: unknown; slots: unknown; channels?: unknown; pickupColumns?: unknown }): ShowPreset {
    if (this.presets.length >= MAX_PRESETS) throw new PresetError(`There's a limit of ${MAX_PRESETS} presets. Delete one first.`);
    const slots = cleanSlots(input.slots);
    const preset: ShowPreset = { id: randomUUID(), name: cleanName(input.name), slots, channels: cleanChannels(input.channels, slots), ...cleanColumns(input.pickupColumns), updatedAt: this.now() };
    this.ensureUniqueName(preset.name);
    this.presets = [...this.presets, preset];
    this.persist();
    return preset;
  }

  update(id: string, input: { name?: unknown; slots?: unknown; channels?: unknown; pickupColumns?: unknown }): ShowPreset {
    const current = this.presets.find((p) => p.id === id);
    if (!current) throw new PresetError('That preset no longer exists.');
    const slots = input.slots === undefined ? current.slots : cleanSlots(input.slots);
    const next: ShowPreset = {
      ...current,
      name: input.name === undefined ? current.name : cleanName(input.name),
      slots,
      // Settings for a channel taken out of the preset go with it.
      channels: cleanChannels(input.channels === undefined ? current.channels : input.channels, slots),
      pickupColumns: undefined,
      ...cleanColumns(input.pickupColumns === undefined ? current.pickupColumns : input.pickupColumns),
      updatedAt: this.now(),
    };
    if (next.name.toLowerCase() !== current.name.toLowerCase()) this.ensureUniqueName(next.name);
    this.presets = this.presets.map((p) => (p.id === id ? next : p));
    this.persist();
    return next;
  }

  /**
   * Star or unstar a channel on the Planning Center screen. Starred channels
   * make up one preset (created with the first star, renamable like any
   * other), so the pickup display can show just the mics that are synced.
   * Unstarring the last channel deletes it.
   */
  star(key: unknown, on: boolean): ShowPreset | undefined {
    if (typeof key !== 'string' || !key || key.length > 200) throw new PresetError('Choose a channel.');
    const current = this.presets.find((p) => p.starred);
    if (!current) {
      if (!on) return undefined;
      let name = STARRED_NAME;
      for (let i = 2; this.presets.some((p) => p.name.toLowerCase() === name.toLowerCase()); i++) name = `${STARRED_NAME} ${i}`;
      const created = this.create({ name, slots: [key] });
      return this.mark(created.id);
    }
    const slots = on ? [...new Set([...current.slots, key])] : current.slots.filter((k) => k !== key);
    if (slots.length === 0) {
      this.delete(current.id);
      return undefined;
    }
    return this.update(current.id, { slots });
  }

  private mark(id: string): ShowPreset {
    this.presets = this.presets.map((p) => (p.id === id ? { ...p, starred: true as const } : p));
    this.persist();
    return this.presets.find((p) => p.id === id)!;
  }

  delete(id: string): void {
    if (!this.presets.some((p) => p.id === id)) throw new PresetError('That preset no longer exists.');
    this.presets = this.presets.filter((p) => p.id !== id);
    // The pickup display falls back to every channel rather than a preset that's gone.
    if (this.pickup === id) this.pickup = undefined;
    this.persist();
  }

  private ensureUniqueName(name: string): void {
    const existing = this.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) throw new PresetError(`A preset called "${existing.name}" already exists.`);
  }

  private persist(): void {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      // Write then rename, so a crash mid-write can't leave a half-written file.
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, presets: this.presets, pickupPreset: this.pickup }, null, 2) + '\n');
      renameSync(tmp, this.path);
    }
    this.emit('change');
  }
}

function load(path: string): { presets: ShowPreset[]; pickup: string | undefined } {
  let raw: { presets?: unknown; pickupPreset?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as typeof raw;
  } catch {
    return { presets: [], pickup: undefined };
  }
  const presets = loadPresets(raw.presets);
  const pickup = typeof raw.pickupPreset === 'string' && presets.some((p) => p.id === raw.pickupPreset) ? raw.pickupPreset : undefined;
  return { presets, pickup };
}

function loadPresets(list: unknown): ShowPreset[] {
  try {
    if (!Array.isArray(list)) return [];
    return list.flatMap((p): ShowPreset[] => {
      try {
        const o = p as Record<string, unknown>;
        const slots = cleanSlots(o.slots);
        let channels: ShowPreset['channels'] = {};
        try {
          channels = cleanChannels(o.channels, slots);
        } catch {
          // keep the preset; only its per-channel settings are lost
        }
        return [{ id: String(o.id), name: cleanName(o.name), slots, channels, ...cleanColumns(o.pickupColumns), ...(o.starred === true ? { starred: true as const } : {}), updatedAt: Number(o.updatedAt) || 0 }];
      } catch {
        return []; // skip a damaged entry rather than losing the rest
      }
    });
  } catch {
    return [];
  }
}

function cleanName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new PresetError('Give the preset a name.');
  if (name.length > MAX_NAME) throw new PresetError(`Keep the name under ${MAX_NAME} characters.`);
  return name;
}

function cleanSlots(v: unknown): string[] {
  if (!Array.isArray(v)) throw new PresetError('A preset needs a list of channels.');
  const keys = [...new Set(v.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200))];
  if (keys.length === 0) throw new PresetError('Pick at least one channel for the preset.');
  if (keys.length > MAX_SLOTS) throw new PresetError('Too many channels in one preset.');
  return keys;
}

/** Pickup display columns: 1-8, or left out for automatic. */
function cleanColumns(v: unknown): { pickupColumns?: number } {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isInteger(n) && n >= 1 && n <= 8 ? { pickupColumns: n } : {};
}

/** Nicknames and waveform switches, kept only for channels in the preset and only when set. */
function cleanChannels(v: unknown, slots: string[]): Record<string, PresetChannel> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new PresetError('Channel settings are in the wrong format.');
  const out: Record<string, PresetChannel> = {};
  for (const key of slots) {
    const raw = (v as Record<string, unknown>)[key];
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const c: PresetChannel = {};
    if (o.nickname !== undefined) {
      if (typeof o.nickname !== 'string') throw new PresetError('A nickname must be text.');
      const nickname = o.nickname.trim().replace(/\s+/g, ' ');
      if (nickname.length > MAX_NICKNAME) throw new PresetError(`Keep nicknames under ${MAX_NICKNAME} characters.`);
      if (nickname) c.nickname = nickname;
    }
    if (o.waveform === true) c.waveform = true;
    if (c.nickname || c.waveform) out[key] = c;
  }
  return out;
}
