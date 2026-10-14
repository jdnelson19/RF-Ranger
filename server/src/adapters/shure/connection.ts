import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { ConnectionStatus } from '../../core/model.js';
import { ShureFramer, parseMessage, type ShureMessage } from './protocol.js';

export const SHURE_PORT = 2202;
/** PSM 1000 (P10T) control port, per Shure's PSM1000 command strings. */
export const PSM_PORT = 2201;
/** Ports tried, in order, when a device's port isn't known. */
export const SHURE_PORTS: readonly number[] = [SHURE_PORT, PSM_PORT];

export interface ShureConnectionOptions {
  host: string;
  port?: number;
  /** Frames to send on every (re)connect: initial GETs, metering setup. */
  onConnect: () => string[];
  /** Frames to send before a deliberate close, e.g. metering off. */
  onClose?: () => string[];
  /**
   * Sent whenever the link has been idle for `heartbeatMs`. Needed for
   * devices that only report on change (chargers), so silence still means
   * a dead link rather than "nothing happened".
   */
  heartbeat?: string;
  heartbeatMs?: number;
  /** Drop and reconnect when nothing is heard for this long. */
  silenceTimeoutMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
}

interface Events {
  status: [ConnectionStatus];
  message: [msg: ShureMessage, now: number];
  /** Every frame in or out, for logging and diagnostics. */
  wire: [direction: 'in' | 'out', frame: string];
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

/**
 * A persistent TCP link to any Shure device on the third-party protocol:
 * reconnects with backoff, keeps the link verifiably alive, and runs the
 * device's shutdown frames before a deliberate close.
 */
export class ShureConnection extends EventEmitter<Events> {
  private _status: ConnectionStatus;
  private socket: net.Socket | undefined;
  private framer = new ShureFramer();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private lastSentAt = 0;
  private attempt = 0;
  private stopped = true;
  private readonly port: number;
  private readonly heartbeatMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  readonly now: () => number;

  constructor(private readonly opts: ShureConnectionOptions) {
    super();
    this.port = opts.port ?? SHURE_PORT;
    this.heartbeatMs = opts.heartbeatMs ?? 2_000;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? 5_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 3_000;
    this.now = opts.now ?? Date.now;
    this._status = { state: 'disconnected', since: this.now() };
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get host(): string {
    return this.opts.host;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.tick(), 250);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    const socket = this.socket;
    if (!socket) return;
    if (this._status.state === 'connected') {
      for (const frame of this.opts.onClose?.() ?? []) this.send(frame);
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
      socket.once('close', () => { clearTimeout(force); resolve(); });
      socket.end();
    });
  }

  send(frame: string): void {
    if (!this.socket || this.socket.destroyed) return;
    this.lastSentAt = this.now();
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
      for (const frame of this.opts.onConnect()) this.send(frame);
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

    socket.connect(this.port, this.opts.host);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private tick(): void {
    const s = this._status;
    if (s.state !== 'connected' || s.lastMessageAt === undefined) return;
    const now = this.now();
    if (now - s.lastMessageAt > this.silenceTimeoutMs) {
      this.socket?.destroy(new Error(`No data for ${this.silenceTimeoutMs} ms`));
    } else if (this.opts.heartbeat && now - Math.max(s.lastMessageAt, this.lastSentAt) >= this.heartbeatMs) {
      this.send(this.opts.heartbeat);
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
      this.emit('message', parseMessage(frame), now);
    }
  }
}
