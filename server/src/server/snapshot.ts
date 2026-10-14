/** Wire format shared with the web UI. */
import type { Alert } from '../core/alerts.js';
import type { BayTelemetry, ChannelTelemetry, ChargerInfo, ConnectionStatus, ReceiverInfo } from '../core/model.js';
import type { Readiness } from '../core/readiness.js';
import type { AssignmentConfig, SlotConfig } from '../core/assignment.js';

export interface SlotView {
  slot: number;
  label: string;
  kind: SlotConfig['kind'];
  group?: string;
  receiverId: string;
  channel: number;
  family: string;
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

export interface Snapshot {
  /** Data comes from built-in simulators, not real hardware. */
  demo: boolean;
  serverTime: number;
  groups: string[];
  slots: SlotView[];
  receivers: DeviceView<ReceiverInfo>[];
  chargers: (DeviceView<ChargerInfo> & { bays: Record<number, BayTelemetry> })[];
}
