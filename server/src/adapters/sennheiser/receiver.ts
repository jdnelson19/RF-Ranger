/**
 * A networked Sennheiser receiver (EW-DX EM 2/EM 4, Digital 6000 EM 6000)
 * over SSC v1. Reads everything on connect, subscribes to value changes and
 * to metering, and cancels the subscriptions before closing.
 */
import { EventEmitter } from 'node:events';
import { LevelRecorder } from '../../core/history.js';
import type { ConnectionStatus, ReceiverInfo } from '../../core/model.js';
import { recordLevels, type ChannelState, type ReceiverDevice, type ReceiverEvents } from '../device.js';
import { SscConnection } from './connection.js';
import { SENNHEISER_FAMILIES, initialTelemetry, type SennheiserFamily, type SennheiserFamilyId } from './families.js';
import { errors, leaves, merge, subscribe, tree, type SscValue } from './ssc.js';

export interface SennheiserReceiverOptions {
  id: string;
  host: string;
  family: SennheiserFamilyId;
  port?: number;
  channels?: number;
  /** Meter notification interval. */
  meterRateMs?: number;
  silenceTimeoutMs?: number;
  now?: () => number;
}

const IDENTITY = merge(tree(['device', 'name']), tree(['device', 'identity', 'product']), tree(['device', 'identity', 'version']), tree(['device', 'identity', 'serial']));

export class SennheiserReceiver extends EventEmitter<ReceiverEvents> implements ReceiverDevice {
  readonly family: SennheiserFamily;
  readonly info: ReceiverInfo;
  readonly channels = new Map<number, ChannelState>();
  private readonly conn: SscConnection;

  constructor(opts: SennheiserReceiverOptions) {
    super();
    this.family = SENNHEISER_FAMILIES[opts.family];
    const count = opts.channels ?? this.family.defaultChannels;
    this.info = { id: opts.id, manufacturer: 'sennheiser', family: this.family.id, role: 'mic', host: opts.host, channelCount: count };
    for (let ch = 1; ch <= count; ch++) this.channels.set(ch, { telemetry: initialTelemetry(this.family), raw: {}, levels: new LevelRecorder() });

    const chs = [...this.channels.keys()];
    const meterRateMs = Math.max(100, opts.meterRateMs ?? 100);
    const subscriptions = () => [
      subscribe(this.family.onChange(chs), { lifetimeS: 60 }),
      subscribe(this.family.meters(chs), { intervalMs: meterRateMs, lifetimeS: 60 }),
    ];
    this.conn = new SscConnection({
      host: opts.host,
      port: opts.port,
      silenceTimeoutMs: opts.silenceTimeoutMs,
      now: opts.now,
      onConnect: () => [IDENTITY, ...chs.map((n) => this.family.read(n)), ...subscriptions()],
      renew: subscriptions,
      // Cancel both subscriptions, so the device stops sending to a closed port.
      onClose: () => [this.family.onChange(chs), this.family.meters(chs)].map((a) => ({ osc: { state: { subscribe: [{ '#': { cancel: true }, ...a }] } } })),
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
  }

  stop(): Promise<void> {
    return this.conn.stop();
  }

  /** One raw SSC message, as JSON text (the Inspector's queries). */
  send(frame: string): void {
    this.conn.send(JSON.parse(frame) as Record<string, SscValue>);
  }

  private handle(msg: Record<string, SscValue>, now: number): void {
    const changed = new Set<number>();
    const metered = new Set<number>();
    const channel = (n: number) => this.channels.get(n)?.telemetry;

    for (const [path, value] of leaves(msg)) {
      if (path.startsWith('/device/')) {
        this.applyDevice(path, value);
        continue;
      }
      const m = /^\/rx(\d+)\//.exec(path);
      const t = m ? channel(Number(m[1])) : undefined;
      if (t && this.family.rereadOn?.(path, value, t)) this.conn.send(this.family.read(Number(m![1])));
      const hit = this.family.apply(path, value, channel, now);
      for (const n of hit === undefined ? [] : Array.isArray(hit) ? hit : [hit]) {
        changed.add(n);
        const ch = this.channels.get(n);
        if (ch) ch.raw[path] = JSON.stringify(value);
        if (path.startsWith('/m/') || path === '/mm') metered.add(n);
      }
    }
    for (const [path, code] of errors(msg)) {
      // 310: a subscription ran out (lifetime or count); ask again straight away.
      if (code === 310) this.conn.renewSoon();
      const n = this.family.applyError(path, code, channel, now);
      if (n !== undefined) changed.add(n);
    }
    for (const n of metered) recordLevels(this.channels.get(n)!, now);
    for (const n of changed) this.emit('channel', n, this.channels.get(n)!);
  }

  private applyDevice(path: string, value: SscValue): void {
    const text = typeof value === 'string' ? value.trim() : undefined;
    if (!text) return;
    if (path === '/device/name' && this.info.deviceId !== text) this.info.deviceId = text;
    else if (path === '/device/identity/product' && this.info.model !== text) this.info.model = text;
    else if (path === '/device/identity/version' && this.info.firmware !== text) this.info.firmware = text;
    else return;
    this.emit('info', this.info);
  }
}
