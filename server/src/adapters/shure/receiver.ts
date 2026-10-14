import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { ChannelTelemetry, ConnectionStatus, ReceiverInfo } from '../../core/model.js';
import { SHURE_FAMILIES, initialTelemetry, type ShureFamily, type ShureFamilyId } from './families.js';
import { ShureFramer, getCommand, meterRateCommand, parseMessage } from './protocol.js';

export const SHURE_PORT = 2202;

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
  /** Every frame in or out, for logging and diagnostics. */
  wire: [direction: 'in' | 'out', frame: string];
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

/**
 * One TCP connection to a Shure receiver, kept alive indefinitely: it
 * reconnects with backoff, treats silence as a dead link, and turns metering
 * off before closing so receivers aren't left streaming to nobody.
 */
export class ShureReceiver extends EventEmitter<Events> {
  readonly family: ShureFamily;
  readonly info: ReceiverInfo;
  readonly channels = new Map<number, ChannelState>();
  readonly deviceRaw: Record<string, string> = {};

  private _status: ConnectionStatus;
  private socket: net.Socket | undefined;
  private framer = new ShureFramer();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = true;
  private readonly port: number;
  private readonly meterRateMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: ShureReceiverOptions) {
    super();
    this.family = SHURE_FAMILIES[opts.family];
    this.port = opts.port ?? SHURE_PORT;
    this.meterRateMs = Math.max(100, opts.meterRateMs ?? 250);
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? 5_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 3_000;
    this.now = opts.now ?? Date.now;

    const channelCount = opts.channels ?? this.family.defaultChannels;
    this.info = { id: opts.id, manufacturer: 'shure', family: this.family.id, host: opts.host, channelCount };
    for (let ch = 1; ch <= channelCount; ch++) {
      this.channels.set(ch, { telemetry: initialTelemetry(this.family), raw: {} });
    }
    this._status = { state: 'disconnected', since: this.now() };
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkSilence(), 500);
  }

  /** Turns metering off, closes cleanly, and stops reconnecting. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    const socket = this.socket;
    if (!socket) return;
    if (this._status.state === 'connected') {
      for (const ch of this.channels.keys()) this.send(meterRateCommand(ch, 0));
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
      socket.once('close', () => { clearTimeout(force); resolve(); });
      socket.end();
    });
  }

  send(frame: string): void {
    if (!this.socket || this.socket.destroyed) return;
    this.emit('wire', 'out', frame);
    this.socket.write(frame);
  }

  private connect(): void {
    this.setStatus({ state: 'connecting' });
    this.framer = new ShureFramer();
    const socket = new net.Socket();
    this.socket = socket;
    socket.setEncoding('ascii');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5_000);
    socket.setTimeout(this.connectTimeoutMs);

    socket.once('connect', () => {
      socket.setTimeout(0);
      this.attempt = 0;
      this.setStatus({ state: 'connected', lastMessageAt: this.now() });
      this.send(getCommand(undefined, 'MODEL'));
      this.send(getCommand(undefined, 'DEVICE_ID'));
      this.send(getCommand(undefined, 'FW_VER'));
      this.send(getCommand(0, 'ALL'));
      for (const ch of this.channels.keys()) this.send(meterRateCommand(ch, this.meterRateMs));
    });
    socket.on('timeout', () => socket.destroy(new Error('Connection timed out')));
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => { this._status = { ...this._status, lastError: err.message }; });
    socket.once('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.setStatus({ state: 'disconnected' });
      this.scheduleReconnect();
    });

    socket.connect(this.port, this.info.host);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private checkSilence(): void {
    const s = this._status;
    if (s.state === 'connected' && s.lastMessageAt !== undefined && this.now() - s.lastMessageAt > this.silenceTimeoutMs) {
      this.socket?.destroy(new Error(`No data for ${this.silenceTimeoutMs} ms`));
    }
  }

  private setStatus(next: Partial<ConnectionStatus> & Pick<ConnectionStatus, 'state'>): void {
    const changed = next.state !== this._status.state;
    this._status = {
      ...this._status,
      ...next,
      since: changed ? this.now() : this._status.since,
      lastError: next.state === 'connected' ? undefined : (next.lastError ?? this._status.lastError),
    };
    if (changed) this.emit('status', this._status);
  }

  private onData(chunk: string): void {
    const now = this.now();
    this._status = { ...this._status, lastMessageAt: now };
    for (const frame of this.framer.push(chunk)) {
      this.emit('wire', 'in', frame);
      this.handle(frame, now);
    }
  }

  private handle(frame: string, now: number): void {
    const msg = parseMessage(frame);

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
      this.deviceRaw[msg.key] = value;
      if (msg.key === 'MODEL') this.info.model = value;
      else if (msg.key === 'DEVICE_ID') this.info.deviceId = value;
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
