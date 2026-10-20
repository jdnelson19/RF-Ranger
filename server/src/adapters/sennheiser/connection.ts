/**
 * A link to one Sennheiser SSC device over UDP (see ssc.ts). UDP has no
 * connection, so "connected" means the device has answered recently: a
 * ping goes out when the link is quiet, and silence beyond the timeout marks
 * it offline until it answers again. Subscriptions lapse on the device after
 * their lifetime, so they're renewed well before then, and again whenever the
 * device comes back.
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { ConnectionStatus } from '../../core/model.js';
import { SSC_PORT, type SscValue } from './ssc.js';

export interface SscConnectionOptions {
  host: string;
  port?: number;
  /** Messages to send whenever the device (re)appears: reads and subscriptions. */
  onConnect: () => Record<string, SscValue>[];
  /** Re-sent this often while up, so subscriptions never lapse. */
  renew?: () => Record<string, SscValue>[];
  renewMs?: number;
  /** Sent before a deliberate close, e.g. cancelling subscriptions. */
  onClose?: () => Record<string, SscValue>[];
  silenceTimeoutMs?: number;
  pingMs?: number;
  now?: () => number;
}

interface Events {
  status: [ConnectionStatus];
  message: [msg: Record<string, SscValue>, now: number];
  wire: [direction: 'in' | 'out', frame: string];
}

const PING: Record<string, SscValue> = { osc: { ping: null } };

export class SscConnection extends EventEmitter<Events> {
  private _status: ConnectionStatus;
  private socket: dgram.Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastRenew = 0;
  private lastSentAt = 0;
  private stopped = true;
  readonly now: () => number;
  private readonly port: number;
  private readonly silenceTimeoutMs: number;
  private readonly pingMs: number;
  private readonly renewMs: number;

  constructor(private readonly opts: SscConnectionOptions) {
    super();
    this.now = opts.now ?? Date.now;
    this.port = opts.port ?? SSC_PORT;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? 5_000;
    this.pingMs = opts.pingMs ?? 1_500;
    this.renewMs = opts.renewMs ?? 30_000;
    this._status = { state: 'disconnected', since: this.now() };
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('message', (buf, rinfo) => {
      if (rinfo.address !== this.opts.host) return;
      const text = buf.toString('utf8');
      this.emit('wire', 'in', text);
      let msg: Record<string, SscValue>;
      try {
        msg = JSON.parse(text) as Record<string, SscValue>;
      } catch {
        return; // not SSC
      }
      const now = this.now();
      const wasUp = this._status.state === 'connected';
      this.setStatus({ state: 'connected', since: wasUp ? this._status.since : now, lastMessageAt: now });
      if (!wasUp) this.hello();
      this.emit('message', msg, now);
    });
    socket.on('error', (err) => this.setStatus({ ...this._status, lastError: err.message }));
    socket.bind(0, () => {
      this.setStatus({ state: 'connecting', since: this.now() });
      this.hello();
      this.timer = setInterval(() => this.tick(), 500);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    for (const m of this.opts.onClose?.() ?? []) this.send(m);
    await new Promise<void>((r) => setTimeout(r, 50)); // let the last datagrams leave
    this.socket?.close();
    this.socket = undefined;
    this.setStatus({ state: 'disconnected', since: this.now() });
  }

  send(msg: Record<string, SscValue>): void {
    if (!this.socket) return;
    const text = JSON.stringify(msg);
    this.lastSentAt = this.now();
    this.emit('wire', 'out', text);
    this.socket.send(text, this.port, this.opts.host);
  }

  /** Renew the subscriptions on the next tick (the device ended one: error 310). Several ends in a row renew once. */
  renewSoon(): void {
    this.lastRenew = 0;
  }

  /** Reads and subscriptions, sent on start and whenever the device reappears. */
  private hello(): void {
    this.lastRenew = this.now();
    for (const m of this.opts.onConnect()) this.send(m);
  }

  private tick(): void {
    const now = this.now();
    const s = this._status;
    if (s.state === 'connected' && s.lastMessageAt !== undefined && now - s.lastMessageAt > this.silenceTimeoutMs) {
      this.setStatus({ state: 'connecting', since: now, lastMessageAt: s.lastMessageAt, lastError: `No answer for ${Math.round(this.silenceTimeoutMs / 1000)} s` });
    }
    if (this._status.state !== 'connected') {
      // Keep asking: the first answer brings it back (and re-sends the subscriptions).
      if (now - this.lastSentAt >= 2_000) this.hello();
      return;
    }
    if (now - this.lastRenew >= this.renewMs) {
      this.lastRenew = now;
      for (const m of this.opts.renew?.() ?? this.opts.onConnect()) this.send(m);
    }
    if (now - (s.lastMessageAt ?? 0) >= this.pingMs && now - this.lastSentAt >= this.pingMs) this.send(PING);
  }

  private setStatus(next: ConnectionStatus): void {
    const prev = this._status;
    this._status = next;
    if (prev.state !== next.state || prev.lastError !== next.lastError) this.emit('status', next);
  }
}
