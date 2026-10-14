import { readFileSync } from 'node:fs';
import type { ShureFamilyId } from '../adapters/shure/families.js';
import type { AlertThresholds } from '../core/alerts.js';
import type { SlotConfig } from '../core/assignment.js';
import { DEFAULT_THRESHOLDS } from '../core/readiness.js';

export interface ReceiverConfig {
  id: string;
  family: ShureFamilyId;
  host: string;
  port?: number;
  channels?: number;
}

export interface ChargerConfig {
  id: string;
  host: string;
  port?: number;
}

export type { AssignmentConfig, SlotConfig } from '../core/assignment.js';

export interface Config {
  port: number;
  receivers: ReceiverConfig[];
  chargers: ChargerConfig[];
  slots: SlotConfig[];
  /** Display order of groups; groups not listed follow alphabetically. */
  groups: string[];
  photosDir?: string;
  thresholds: AlertThresholds;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  ...DEFAULT_THRESHOLDS,
  rfWeakDbm: -85,
  runtimeWarnMin: 60,
};

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return normalizeConfig(raw);
}

export function normalizeConfig(raw: Partial<Config>): Config {
  const config: Config = {
    port: raw.port ?? 8058,
    receivers: raw.receivers ?? [],
    chargers: raw.chargers ?? [],
    slots: raw.slots ?? [],
    groups: raw.groups ?? [],
    photosDir: raw.photosDir,
    thresholds: { ...DEFAULT_ALERT_THRESHOLDS, ...raw.thresholds },
  };

  const receiverIds = new Set(config.receivers.map((r) => r.id));
  const chargerIds = new Set(config.chargers.map((c) => c.id));
  const seenSlots = new Set<number>();
  for (const s of config.slots) {
    if (seenSlots.has(s.slot)) throw new Error(`Config: slot ${s.slot} is defined twice`);
    seenSlots.add(s.slot);
    if (!receiverIds.has(s.receiver)) throw new Error(`Config: slot ${s.slot} refers to unknown receiver "${s.receiver}"`);
    const charger = s.assignment?.charger;
    if (charger && !chargerIds.has(charger.id)) throw new Error(`Config: slot ${s.slot} refers to unknown charger "${charger.id}"`);
  }
  return config;
}
