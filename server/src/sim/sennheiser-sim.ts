import dgram from 'node:dgram';
import type { SennheiserFamilyId } from '../adapters/sennheiser/families.js';
import { SSC_PORT, leaves, merge, tree, type SscValue } from '../adapters/sennheiser/ssc.js';

/**
 * A fake Sennheiser receiver speaking SSC v1 over UDP (EW-DX EM 2/EM 4 or
 * Digital 6000 EM 6000), for tests and development without hardware. It
 * follows the developer guides: reads return values at the same address,
 * unknown addresses get 404, transmitter addresses on EW-DX get 424 while no
 * transmitter is on, and subscriptions notify on change or periodically until
 * their lifetime runs out (then 310). Like ShureSim, what it sends is "live"
 * from RF Ranger's point of view.
 */

export interface SennheiserSimChannel {
  name: string;
  frequencyKhz: number;
  txOn: boolean;
  txModel: string;
  txName: string;
  /** EW-DX: gauge %. */
  batteryPercent: number;
  runtimeMin: number;
  /** EW-DX: "Primary Cell" (AA) rather than a BA 70 pack. */
  primaryCell: boolean;
  /** Digital 6000: "100%", "70%", "30%" or "low". */
  batteryState: string;
  rfDbm: number;
  audioDbfs: number;
  rxMuted: boolean;
  txMuted: boolean;
  aesError: boolean;
}

export interface SennheiserSimOptions {
  family: SennheiserFamilyId;
  product?: string;
  deviceName?: string;
  channels?: Partial<SennheiserSimChannel>[];
}

const DEFAULT_PRODUCT: Record<SennheiserFamilyId, string> = { ewdx: 'EW-DX EM 4', d6000: 'EM 6000' };
const DEFAULT_TX: Record<SennheiserFamilyId, string> = { ewdx: 'SKM-S', d6000: 'SK 6000' };

interface Subscription {
  to: { address: string; port: number };
  addresses: Record<string, SscValue>;
  /** Periodic notification interval; 0 = on change only. */
  everyMs: number;
  expiresAt: number;
  lastSentAt: number;
  last: string;
  sent: number;
  count: number;
}

const isObject = (v: SscValue | undefined): v is { [key: string]: SscValue } => typeof v === 'object' && v !== null && !Array.isArray(v);

export class SennheiserSim {
  readonly family: SennheiserFamilyId;
  readonly product: string;
  deviceName: string;
  readonly channels: SennheiserSimChannel[];
  /** Every request received, for tests. */
  readonly received: Record<string, SscValue>[] = [];
  private socket = dgram.createSocket('udp4');
  private subs = new Map<string, Subscription>();
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: SennheiserSimOptions) {
    this.family = opts.family;
    this.product = opts.product ?? DEFAULT_PRODUCT[opts.family];
    this.deviceName = opts.deviceName ?? 'SIM';
    const count = opts.channels?.length ?? (opts.family === 'ewdx' && /EM\s?4/.test(this.product) ? 4 : 2);
    this.channels = Array.from({ length: count }, (_, i) => ({
      name: `CH ${i + 1}`,
      frequencyKhz: 520_100 + i * 1_000,
      txOn: true,
      txModel: DEFAULT_TX[opts.family],
      txName: `TX${i + 1}`,
      batteryPercent: 90,
      runtimeMin: 420,
      primaryCell: false,
      batteryState: '100%',
      rfDbm: -55,
      audioDbfs: -30,
      rxMuted: false,
      txMuted: false,
      aesError: false,
      ...opts.channels?.[i],
    }));
    this.socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(port, host, () => {
        this.socket.off('error', reject);
        this.timer = setInterval(() => this.notify(), 50);
        resolve(this.socket.address().port);
      });
    });
  }

  close(): Promise<void> {
    clearInterval(this.timer);
    return new Promise((r) => {
      try { this.socket.close(() => r()); } catch { r(); }
    });
  }

  update(channel: number, patch: Partial<SennheiserSimChannel>): void {
    Object.assign(this.channels[channel - 1]!, patch);
  }

  /** Open subscriptions, for tests. */
  get subscriptions(): number {
    return this.subs.size;
  }

  /** Every address the sim answers, for /osc/schema. */
  addresses(): string[] {
    const dev = ['device/name', 'device/identity/product', 'device/identity/version', 'device/identity/serial', 'device/identity/vendor'];
    const per = this.family === 'ewdx'
      ? ['rx#/name', 'rx#/frequency', 'rx#/mute', 'rx#/warnings', 'rx#/mates', 'm/rx#/rssi', 'm/rx#/rsqi', 'm/rx#/divi', 'm/rx#/af',
        'mates/tx#/type', 'mates/tx#/name', 'mates/tx#/mute', 'mates/tx#/warnings', 'mates/tx#/battery/gauge', 'mates/tx#/battery/lifetime', 'mates/tx#/battery/type']
      : ['rx#/name', 'rx#/carrier', 'rx#/audio_mute', 'rx#/active_warnings', 'rx#/skx/type', 'rx#/skx/name', 'rx#/skx/battery'];
    return [...dev, ...(this.family === 'd6000' ? ['mm'] : []), ...this.channels.flatMap((_, i) => per.map((p) => p.replace('#', String(i + 1))))];
  }

  /** /osc/schema: the children of an address, {} for a branch and null for a value. */
  private schema(path: string[]): SscValue | undefined {
    const prefix = path.length ? `${path.join('/')}/` : '';
    const children: Record<string, SscValue> = {};
    for (const a of this.addresses()) {
      if (!a.startsWith(prefix)) continue;
      const rest = a.slice(prefix.length).split('/');
      children[rest[0]!] = rest.length > 1 ? {} : null;
    }
    return Object.keys(children).length ? children : undefined;
  }

  /** Current value of an address, or an error code. */
  private value(path: string): SscValue | { error: number } {
    const dev: Record<string, SscValue> = {
      '/device/name': this.deviceName,
      '/device/identity/product': this.product,
      '/device/identity/version': '2.0.0',
      '/device/identity/serial': '0000000000',
      '/device/identity/vendor': 'Sennheiser',
    };
    if (path in dev) return dev[path]!;
    return (this.family === 'ewdx' ? this.ewdx(path) : this.d6000(path)) ?? { error: 404 };
  }

  private ewdx(path: string): SscValue | { error: number } | undefined {
    let m = /^\/rx(\d+)\/(name|frequency|mute|warnings|mates)$/.exec(path);
    if (m) {
      const c = this.channels[Number(m[1]) - 1];
      if (!c) return undefined;
      const n = Number(m[1]);
      return {
        name: c.name,
        frequency: c.frequencyKhz,
        mute: c.rxMuted,
        warnings: [...(c.txOn ? [] : ['NoLink']), ...(c.aesError ? ['Aes256Error'] : [])],
        mates: c.txOn ? [`mates/tx${n}`] : [],
      }[m[2]!]!;
    }
    m = /^\/m\/rx(\d+)\/(rssi|rsqi|divi|af)$/.exec(path);
    if (m) {
      const c = this.channels[Number(m[1]) - 1];
      if (!c) return undefined;
      return { rssi: c.txOn ? c.rfDbm : -107, rsqi: c.txOn ? 90 : 0, divi: c.txOn ? 1 : 0, af: c.txOn ? c.audioDbfs : -100 }[m[2]!]!;
    }
    m = /^\/mates\/tx(\d+)\/(type|name|mute|warnings|battery\/gauge|battery\/lifetime|battery\/type)$/.exec(path);
    if (m) {
      const c = this.channels[Number(m[1]) - 1];
      if (!c) return undefined;
      // "TX is not present or doesn't send valid information" (EW-DX guide).
      if (!c.txOn) return { error: 424 };
      return {
        type: c.txModel,
        name: c.txName,
        mute: c.txMuted,
        warnings: c.batteryPercent <= 10 ? ['LowBattery'] : [],
        'battery/gauge': c.batteryPercent,
        'battery/lifetime': c.runtimeMin,
        'battery/type': c.primaryCell ? 'Primary Cell' : 'Battery',
      }[m[2]!]!;
    }
    return undefined;
  }

  private d6000(path: string): SscValue | undefined {
    if (path === '/mm') {
      // Raw units: dBm = (v - 255) / 2, dBFS = (v + 1) / 2 - 128.
      return this.channels.map((c) => {
        const rf = c.txOn ? Math.round(c.rfDbm * 2 + 255) : 0;
        const af = c.txOn ? Math.round((c.audioDbfs + 128) * 2 - 1) : 0;
        return [rf, rf, Math.max(0, rf - 6), Math.max(0, rf - 6), c.txOn ? 1 : 0, 0, c.txOn ? 230 : 0, af, 0];
      });
    }
    const m = /^\/rx(\d+)\/(name|carrier|audio_mute|active_warnings|skx\/type|skx\/name|skx\/battery)$/.exec(path);
    if (!m) return undefined;
    const c = this.channels[Number(m[1]) - 1];
    if (!c) return undefined;
    const hm = `${Math.floor(c.runtimeMin / 60)}:${String(c.runtimeMin % 60).padStart(2, '0')}`;
    return {
      name: c.name,
      carrier: c.frequencyKhz,
      audio_mute: c.rxMuted,
      active_warnings: [...(c.txOn ? [] : ['NoLink']), ...(c.aesError ? ['Aes256Error'] : [])],
      'skx/type': c.txOn ? [c.txModel, '470 MHz', '558 MHz'] : [],
      'skx/name': c.txOn ? c.txName : '',
      'skx/battery': c.txOn ? [c.batteryState, hm] : [],
    }[m[2]!]!;
  }

  /** Answer every address in a request: values in place, errors under /osc/error. */
  private answer(request: Record<string, SscValue>): Record<string, SscValue> | undefined {
    const values: Record<string, SscValue>[] = [];
    const errs: Record<string, SscValue>[] = [];
    for (const [path, set] of leaves(request)) {
      const parts = path.slice(1).split('/');
      if (set !== null && /^\/rx\d+\/name$/.test(path) && typeof set === 'string') {
        const c = this.channels[Number(parts[0]!.slice(2)) - 1];
        if (c) c.name = set.slice(0, 8);
      }
      const v = this.value(path);
      if (isObject(v) && typeof v.error === 'number') errs.push(tree(parts, [v.error, { desc: v.error === 424 ? 'failed dependency' : 'address not found' }]));
      else values.push(tree(parts, v as SscValue));
    }
    if (!values.length && !errs.length) return undefined;
    const out = merge(...values);
    if (errs.length) out.osc = { error: errs };
    return out;
  }

  private onMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    let msg: Record<string, SscValue>;
    try {
      msg = JSON.parse(buf.toString('utf8')) as Record<string, SscValue>;
    } catch {
      return;
    }
    this.received.push(msg);
    const to = { address: rinfo.address, port: rinfo.port };
    const osc = msg.osc;
    if (isObject(osc)) {
      if ('ping' in osc) this.send(to, { osc: { ping: null } });
      if ('schema' in osc) {
        const asked = osc.schema === null ? [[]] : Array.isArray(osc.schema) ? osc.schema.flatMap((t) => (isObject(t) ? leaves(t).map(([p]) => p.slice(1).split('/')) : [])) : [];
        for (const path of asked) {
          const kids = this.schema(path);
          this.send(to, kids ? { osc: { schema: [path.length ? tree(path, kids) : kids] } } : { osc: { error: [{ osc: { schema: [404, { desc: 'address not found' }] } }] } });
        }
      }
      const sub = isObject(osc.state) ? osc.state.subscribe : undefined;
      if (Array.isArray(sub)) for (const s of sub) if (isObject(s)) this.subscribe(to, s);
    }
    const { osc: _, ...rest } = msg;
    if (Object.keys(rest).length) {
      const reply = this.answer(rest);
      if (reply) this.send(to, reply);
    }
  }

  private subscribe(to: Subscription['to'], s: { [key: string]: SscValue }): void {
    const { '#': params, ...addresses } = s;
    const p = isObject(params) ? params : {};
    const key = `${to.address}:${to.port} ${JSON.stringify(addresses)}`;
    if (p.cancel === true) {
      this.subs.delete(key);
      return;
    }
    const num = (v: SscValue | undefined, d: number) => (typeof v === 'number' ? v : d);
    const now = Date.now();
    const sub: Subscription = {
      to,
      addresses,
      everyMs: Math.max(num(p.min, 0), num(p.max, 0)),
      expiresAt: now + num(p.lifetime, 10) * 1000,
      lastSentAt: now,
      last: '',
      sent: 0,
      count: num(p.count, 1000),
    };
    this.subs.set(key, sub);
    this.send(to, { osc: { state: { subscribe: [s] } } });
    this.fire(sub, now);
  }

  private fire(sub: Subscription, now: number): void {
    const reply = this.answer(sub.addresses);
    if (!reply) return;
    sub.last = JSON.stringify(reply);
    sub.lastSentAt = now;
    sub.sent++;
    this.send(sub.to, reply);
  }

  private notify(): void {
    const now = Date.now();
    for (const [key, sub] of this.subs) {
      if (now >= sub.expiresAt || sub.sent >= sub.count) {
        this.subs.delete(key);
        this.send(sub.to, { osc: { error: [{ osc: { state: { subscribe: [310, { desc: 'subscription terminated' }] } } }] } });
        continue;
      }
      if (sub.everyMs > 0) {
        if (now - sub.lastSentAt >= sub.everyMs) this.fire(sub, now);
      } else if (JSON.stringify(this.answer(sub.addresses)) !== sub.last) {
        this.fire(sub, now);
      }
    }
  }

  private send(to: Subscription['to'], msg: Record<string, SscValue>): void {
    try {
      this.socket.send(JSON.stringify(msg), to.port, to.address);
    } catch {
      // closed
    }
  }
}

export { SSC_PORT };
