/**
 * What the runtime needs from any networked rack unit, whatever its maker:
 * a connection status, device info, and per-channel telemetry with a level
 * history, plus events when any of those change. Shure (TCP command strings)
 * and Sennheiser (SSC: JSON over UDP) receivers both implement it.
 */
import type { EventEmitter } from 'node:events';
import type { LevelRecorder } from '../core/history.js';
import type { ChannelRole, ChannelTelemetry, ConnectionStatus, ReceiverInfo } from '../core/model.js';

export interface ChannelState {
  telemetry: ChannelTelemetry;
  /** Latest raw value per protocol key or address, for diagnostics. */
  raw: Record<string, string>;
  /** Recent audio and RF levels, from meter samples. */
  levels: LevelRecorder;
}

export interface ReceiverEvents {
  status: [ConnectionStatus];
  /** A channel's telemetry changed. */
  channel: [channel: number, state: ChannelState];
  info: [ReceiverInfo];
  wire: [direction: 'in' | 'out', frame: string];
}

export interface ReceiverDevice extends EventEmitter<ReceiverEvents> {
  readonly family: { id: string; label: string; role: ChannelRole };
  readonly info: ReceiverInfo;
  readonly channels: Map<number, ChannelState>;
  readonly status: ConnectionStatus;
  start(): void;
  /** Stop metering and close the connection. */
  stop(): Promise<void>;
  /** Send one raw protocol message (the Inspector's queries). */
  send?(frame: string): void;
}

/** Record one meter sample in a channel's level history (audio dBFS, strongest antenna dBm). */
export function recordLevels(ch: ChannelState, now: number): void {
  const t = ch.telemetry;
  const audio = t.audioPeakDbfs.state === 'ok' ? t.audioPeakDbfs.value : t.audioRmsDbfs.state === 'ok' ? t.audioRmsDbfs.value : undefined;
  const rf = t.rfDbm.state === 'ok' && t.rfDbm.value.length ? Math.max(...t.rfDbm.value) : undefined;
  ch.levels.add(now, audio, rf);
}
