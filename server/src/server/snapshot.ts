/** Wire format shared with the web UI. */
import type { Alert } from '../core/alerts.js';
import type { BayTelemetry, ChannelRole, ChannelTelemetry, ChargerInfo, ConnectionStatus, ReceiverInfo } from '../core/model.js';
import type { Readiness } from '../core/readiness.js';
import type { AssignmentConfig, SlotConfig } from '../core/assignment.js';

/** A named, ordered set of channels to monitor at one point in a service (see presets.ts). */
export interface ShowPreset {
  id: string;
  name: string;
  /** Slot keys in display order. */
  slots: string[];
  updatedAt: number;
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
  assignment?: AssignmentConfig & { photoUrl?: string };
  bay?: BayTelemetry;
  readiness: Readiness;
  alerts: Alert[];
}

export interface DeviceView<I> {
  info: I;
  status: ConnectionStatus;
}

export type RunMode = 'config' | 'live' | 'demo';

/** A device seen on the network by discovery or given on the command line. */
export interface DiscoveredView {
  host: string;
  source: 'discovery' | 'manual';
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
}
