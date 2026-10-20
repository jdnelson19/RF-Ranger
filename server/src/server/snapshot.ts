/** Wire format shared with the web UI. */
import type { Alert } from '../core/alerts.js';
import type { LiveNow } from '../core/live.js';
import type { LevelHistory } from '../core/history.js';
import type { BayTelemetry, ChannelRole, ChannelTelemetry, ChargerInfo, ConnectionStatus, ReceiverInfo } from '../core/model.js';
import type { Readiness } from '../core/readiness.js';
import type { AssignmentConfig, SlotConfig } from '../core/assignment.js';

/** A newer RF Ranger release (see update-check.ts). */
export interface UpdateNotice {
  version: string;
  /** The server computer's download (Mac .dmg or Windows installer), else the release page. */
  url: string;
}

/** A named, ordered set of channels to monitor at one point in a service (see presets.ts). */
export interface ShowPreset {
  id: string;
  name: string;
  /** Slot keys in display order. */
  slots: string[];
  /** Per-channel settings within this preset, by slot key. Channels with none are left out. */
  channels: Record<string, PresetChannel>;
  /** Columns on the pickup display; automatic (as many as fit) when left out. */
  pickupColumns?: number;
  updatedAt: number;
}

export interface PresetChannel {
  /** Who is on this transmitter for this show ("Sam" on RF-4), shown in place of the channel name. */
  nickname?: string;
  /** Show the audio and RF history strip on this channel's tile. */
  waveform?: boolean;
}

export interface SlotView {
  slot: number;
  /**
   * Stable identity for this channel, `receiverId/channel`. Unlike the slot
   * number, it doesn't change with discovery order; show presets use it.
   */
  key: string;
  label: string;
  kind: SlotConfig['kind'];
  group?: string;
  receiverId: string;
  channel: number;
  family: string;
  /** `iem`: the rack unit is an in-ear monitor transmitter and the pack reports nothing. */
  role: ChannelRole;
  /** A transmitter is on air (mic channels); the same test readiness uses. */
  txOn: boolean;
  telemetry: ChannelTelemetry;
  /** The last few seconds of audio and RF level (mic channels). */
  levels?: LevelHistory;
  assignment?: AssignmentConfig & {
    photoUrl?: string;
    /** Present when this service's Planning Center roster put the person on this mic. */
    planningCenter?: { unconfirmed: boolean; edited: boolean };
  };
  bay?: BayTelemetry;
  readiness: Readiness;
  alerts: Alert[];
  /** The live Planning Center item's Leader note names this mic's person (see core/live.ts). */
  leading?: boolean;
  /** Mic channels: the key of this person's in-ear monitor channel, paired by name (see pairIems). */
  iem?: string;
}

export interface DeviceView<I> {
  info: I;
  status: ConnectionStatus;
}

export type RunMode = 'config' | 'live' | 'demo';

/** A device seen on the network by discovery or given on the command line. */
export interface DiscoveredView {
  host: string;
  /** remembered: found on an earlier run (see known-devices.ts). */
  source: 'discovery' | 'manual' | 'remembered';
  state: 'identifying' | 'monitoring' | 'unsupported' | 'unreachable';
  model?: string;
  kind?: string;
  deviceId?: string;
  note?: string;
  lastSeen?: number;
}

export interface Snapshot {
  /** Data comes from built-in simulators, not real hardware. */
  demo: boolean;
  /** config: from a config file; live: auto-discovered devices; demo: simulators. */
  mode: RunMode;
  /** Running as the desktop app, which can be quit from the UI on this computer. */
  app: boolean;
  /** RF Ranger version of this server. The app launcher uses it to replace an older server left running. */
  version: string;
  serverTime: number;
  groups: string[];
  slots: SlotView[];
  receivers: DeviceView<ReceiverInfo>[];
  chargers: (DeviceView<ChargerInfo> & { bays: Record<number, BayTelemetry> })[];
  discovered: DiscoveredView[];
  /** Show presets shared by every engineer screen. */
  presets: ShowPreset[];
  /** The preset the pickup display (#/pickup) shows, set from the engineer view; absent: every channel. */
  pickupPreset?: string;
  /** A newer RF Ranger is out (see update-check.ts). */
  update?: UpdateNotice;
  /** What is live in Planning Center Services Live right now (see live-watch.ts). */
  live?: LiveNow;
}
