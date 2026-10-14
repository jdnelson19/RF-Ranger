import { EventEmitter } from 'node:events';
import type { ChannelTelemetry, ConnectionStatus, ReceiverInfo } from '../../core/model.js';
import { ShureConnection } from './connection.js';
import { SHURE_FAMILIES, initialTelemetry, type ShureFamily, type ShureFamilyId } from './families.js';
import { getCommand, meterRateCommand, type ShureMessage } from './protocol.js';

export interface ShureReceiverOptions {
  id: string;
  host: string;
  family: ShureFamilyId;
  port?: number;
  /** Defaults to the family's maximum (e.g. 4 for ULX-D). */
  channels?: number;
  /** SAMPLE interval. Shure's minimum is 100 ms. */
  meterRateMs?: number;
  /** Drop and reconnect when nothing is heard for this long. */
  silenceTimeoutMs?: number;
  /** Re-read reported-on-change values this often. */
  pollIntervalMs?: number;
  connectTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ChannelState {
  telemetry: ChannelTelemetry;
  /** Latest raw value per command key, for diagnostics. */
  raw: Record<string, string>;
}

interface Events {
  status: [ConnectionStatus];
  /** A channel's telemetry changed. */
  channel: [channel: number, state: ChannelState];
  info: [ReceiverInfo];
  wire: [direction: 'in' | 'out', frame: string];
}

/**
 * A networked Shure rack unit: a mic receiver, or for `iem` families an in-ear
 * monitor transmitter. Keeps one connection alive, meters every channel,
 * and turns metering off before closing so receivers aren't left streaming.
 */
export class ShureReceiver extends EventEmitter<Events> {
  readonly family: ShureFamily;
  readonly info: ReceiverInfo;
  readonly channels = new Map<number, ChannelState>();
  readonly deviceRaw: Record<string, string> = {};
  private readonly conn: ShureConnection;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly pollIntervalMs: number;

  constructor(opts: ShureReceiverOptions) {
    super();
    this.family = SHURE_FAMILIES[opts.family];
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    const meterRateMs = Math.max(100, opts.meterRateMs ?? 250);
    const channelCount = opts.channels ?? this.family.defaultChannels;
    this.info = { id: opts.id, manufacturer: 'shure', family: this.family.id, role: this.family.role, host: opts.host, channelCount };
    for (let ch = 1; ch <= channelCount; ch++) {
      this.channels.set(ch, { telemetry: initialTelemetry(this.family), raw: {} });
    }

    const family = this.family;
    const channelReads = () =>
      family.getAll
        ? [getCommand(0, 'ALL')]
        : [...this.channels.keys()].flatMap((ch) => Object.keys(family.reports).map((key) => getCommand(ch, key)));

    this.conn = new ShureConnection({
      host: opts.host,
      port: opts.port ?? family.defaultPort,
      silenceTimeoutMs: opts.silenceTimeoutMs,
      connectTimeoutMs: opts.connectTimeoutMs,
      now: opts.now,
      heartbeat: getCommand(undefined, family.deviceIdKey),
      onConnect: () => [
        getCommand(undefined, 'MODEL'),
        getCommand(undefined, family.deviceIdKey),
        getCommand(undefined, 'FW_VER'),
        ...channelReads(),
        ...[...this.channels.keys()].map((ch) => meterRateCommand(ch, meterRateMs)),
      ],
      onClose: () => [...this.channels.keys()].map((ch) => meterRateCommand(ch, 0)),
    });
    this.conn.on('status', (s) => this.emit('status', s));
    this.conn.on('wire', (dir, frame) => this.emit('wire', dir, frame));
    this.conn.on('message', (msg, now) => this.handle(msg, now));
  }

  get status(): ConnectionStatus {
    return this.conn.status;
  }

  start(): void {
    this.conn.start();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): Promise<void> {
    clearInterval(this.pollTimer);
    return this.conn.stop();
  }

  private poll(): void {
    if (this.conn.status.state !== 'connected') return;
    for (const ch of this.channels.keys()) {
      for (const key of this.family.poll) this.send(getCommand(ch, key));
    }
  }

  send(frame: string): void {
    this.conn.send(frame);
  }

  private handle(msg: ShureMessage, now: number): void {
    if (msg.kind === 'sample') {
      const ch = this.channels.get(msg.channel);
      if (!ch) return;
      this.family.applySample(ch.telemetry, msg.args, now);
      this.emit('channel', msg.channel, ch);
      return;
    }

    if (msg.kind !== 'rep') return;

    if (msg.channel === undefined) {
      const value = msg.args.join(' ');
      if (this.deviceRaw[msg.key] === value) return;
      this.deviceRaw[msg.key] = value;
      if (msg.key === 'MODEL') this.info.model = value;
      else if (msg.key === this.family.deviceIdKey) this.info.deviceId = value;
      else if (msg.key === 'FW_VER') this.info.firmware = value;
      else if (msg.key === 'RF_BAND') this.info.rfBand = value;
      else return;
      this.emit('info', this.info);
      return;
    }

    const ch = this.channels.get(msg.channel);
    if (!ch) return;
    ch.raw[msg.key] = msg.args.join(' ');
    const apply = this.family.reports[msg.key];
    if (apply) apply(ch.telemetry, msg.args, now);
    this.emit('channel', msg.channel, ch);
  }
}
