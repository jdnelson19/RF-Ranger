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
import type { ShowPreset } from './snapshot.js';

export type { ShowPreset } from './snapshot.js';
// Keys for channels not currently present are kept, so a preset survives a receiver being offline.

export const MAX_PRESETS = 50;
const MAX_NAME = 60;
const MAX_SLOTS = 512;

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

  /** Without a path, presets live in memory only (tests, demo). */
  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    super();
    if (path) this.presets = load(path);
  }

  list(): ShowPreset[] {
    return this.presets;
  }

  create(input: { name: unknown; slots: unknown }): ShowPreset {
    if (this.presets.length >= MAX_PRESETS) throw new PresetError(`There's a limit of ${MAX_PRESETS} presets. Delete one first.`);
    const preset: ShowPreset = { id: randomUUID(), name: cleanName(input.name), slots: cleanSlots(input.slots), updatedAt: this.now() };
    this.ensureUniqueName(preset.name);
    this.presets = [...this.presets, preset];
    this.persist();
    return preset;
  }

  update(id: string, input: { name?: unknown; slots?: unknown }): ShowPreset {
    const current = this.presets.find((p) => p.id === id);
    if (!current) throw new PresetError('That preset no longer exists.');
    const next: ShowPreset = {
      ...current,
      name: input.name === undefined ? current.name : cleanName(input.name),
      slots: input.slots === undefined ? current.slots : cleanSlots(input.slots),
      updatedAt: this.now(),
    };
    if (next.name.toLowerCase() !== current.name.toLowerCase()) this.ensureUniqueName(next.name);
    this.presets = this.presets.map((p) => (p.id === id ? next : p));
    this.persist();
    return next;
  }

  delete(id: string): void {
    if (!this.presets.some((p) => p.id === id)) throw new PresetError('That preset no longer exists.');
    this.presets = this.presets.filter((p) => p.id !== id);
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
      writeFileSync(tmp, JSON.stringify({ version: 1, presets: this.presets }, null, 2) + '\n');
      renameSync(tmp, this.path);
    }
    this.emit('change');
  }
}

function load(path: string): ShowPreset[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { presets?: unknown };
    if (!Array.isArray(raw.presets)) return [];
    return raw.presets.flatMap((p): ShowPreset[] => {
      try {
        const o = p as Record<string, unknown>;
        return [{ id: String(o.id), name: cleanName(o.name), slots: cleanSlots(o.slots), updatedAt: Number(o.updatedAt) || 0 }];
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
