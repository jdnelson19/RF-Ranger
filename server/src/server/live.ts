import { ShureDiscovery } from '../adapters/shure/discovery.js';
import { SHURE_PORTS } from '../adapters/shure/connection.js';
import { FAMILY_IDS as FAMILIES, defaultPort, isSennheiser, type DeviceFamilyId } from '../adapters/families.js';
import { SscDiscovery } from '../adapters/sennheiser/discovery.js';
import { identifySennheiser, type SscIdentity } from '../adapters/sennheiser/identify.js';
import { SSC_PORT } from '../adapters/sennheiser/ssc.js';
import type { ShureFamilyId } from '../adapters/shure/families.js';
import { identifyShure, identifyShureOnPorts, type Identity } from '../adapters/shure/identify.js';
import type { KnownDevices } from './known-devices.js';
import type { Runtime } from './runtime.js';
import type { DiscoveredView } from './snapshot.js';

export interface LiveTarget {
  host: string;
  port?: number;
  family?: DeviceFamilyId;
  channels?: number;
  charger?: boolean;
  /** Found by Sennheiser's discovery (mDNS _ssc._udp): identify over SSC, not the Shure port. */
  maker?: 'sennheiser';
}

/**
 * Parse a command-line device: `[family@]host[:port][/channels]`, e.g.
 * `10.0.1.20`, `axd@10.0.1.20`, `ulxd@10.0.1.21/2`, `psm1000@10.0.1.30`, `ewdx@10.0.1.40/4`,
 * `d6000@10.0.1.41`, `127.0.0.1:22020`.
 */
export function parseTarget(spec: string, charger = false): LiveTarget {
  const m = /^(?:(\w+)@)?([^:/@\s]+)(?::(\d+))?(?:\/(\d+))?$/.exec(spec.trim());
  if (!m) throw new Error(`Can't read device "${spec}". Use [family@]host[:port][/channels], e.g. axd@10.0.1.20`);
  const [, family, host, port, channels] = m;
  if (family && !FAMILIES.includes(family as DeviceFamilyId)) {
    throw new Error(`Unknown family "${family}" in "${spec}". Use one of: ${FAMILIES.join(', ')}`);
  }
  return {
    host: host!,
    port: port ? Number(port) : undefined,
    family: family as DeviceFamilyId | undefined,
    channels: channels ? Number(channels) : undefined,
    charger,
  };
}

interface Entry extends DiscoveredView {
  target?: LiveTarget;
  lastAttempt: number;
}

const RETRY_MS = 15_000;

/**
 * Quick-start mode: devices come from discovery and/or the command line, are
 * identified over the control port, and supported ones are monitored with
 * slots named from their own channel names.
 */
export class LiveManager {
  private entries = new Map<string, Entry>();
  private discovery: ShureDiscovery | undefined;
  private sscDiscovery: SscDiscovery | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private namesTimer: NodeJS.Timeout | undefined;
  private usedIds = new Set<string>();
  discoveryError: string | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly opts: {
      discover: boolean;
      targets: LiveTarget[];
      /** Devices found before, added at startup even if they don't answer yet. */
      known?: KnownDevices;
      log?: (msg: string) => void;
      onPacket?: (ip: string, text: string) => void;
    },
  ) {
    runtime.discovered = () =>
      [...this.entries.values()]
        .map(({ target: _t, lastAttempt: _a, ...view }) => {
          // A remembered device that has answered is just monitored now.
          const up = view.deviceId && (runtime.receivers.get(view.deviceId) ?? runtime.chargers.get(view.deviceId))?.status.state === 'connected';
          return view.source === 'remembered' && up ? { ...view, note: undefined } : view;
        })
        .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  }

  async start(): Promise<void> {
    this.restoreKnown();
    // Keep the remembered channel names current, so an offline receiver's mics keep their labels.
    this.namesTimer = setInterval(() => this.saveNames(), 30_000);

    for (const t of this.opts.targets) void this.consider(t.host, 'manual', t);

    if (this.opts.discover) {
      const d = new ShureDiscovery();
      this.discovery = d;
      d.on('packet', (ip, text) => {
        this.opts.onPacket?.(ip, text);
        const e = this.entries.get(ip);
        if (e) e.lastSeen = Date.now();
        void this.consider(ip, 'discovery');
      });
      d.on('error', (err) => {
        this.discoveryError = err.message;
        this.log(`Discovery: ${err.message}`);
      });
      const ok = await d.start();
      this.log(ok ? 'Listening for Shure devices on the network…' : 'Discovery unavailable; add devices with --receiver <ip>.');

      // Sennheiser devices announce themselves over mDNS instead.
      const sd = new SscDiscovery();
      this.sscDiscovery = sd;
      sd.on('found', (ip) => {
        const e = this.entries.get(ip);
        if (e) e.lastSeen = Date.now();
        void this.consider(ip, 'discovery', { host: ip, maker: 'sennheiser' });
      });
      sd.on('error', (err) => this.log(`Sennheiser discovery: ${err.message}`));
      if (await sd.start()) this.log('Looking for Sennheiser devices (mDNS _ssc._udp)…');
    }

    // Retry devices that were named on the command line but didn't answer.
    this.retryTimer = setInterval(() => {
      for (const e of this.entries.values()) {
        if (e.state === 'unreachable' && e.source === 'manual') void this.consider(e.target?.host ?? e.host, 'manual', e.target);
      }
    }, RETRY_MS);
  }

  stop(): void {
    this.saveNames();
    clearInterval(this.retryTimer);
    clearInterval(this.namesTimer);
    this.discovery?.stop();
    this.sscDiscovery?.stop();
  }

  private async consider(host: string, source: 'discovery' | 'manual', target?: LiveTarget): Promise<void> {
    const now = Date.now();
    const key = target?.port ? `${host}:${target.port}` : host;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.state !== 'unreachable' || now - existing.lastAttempt < RETRY_MS) return;
    }
    const entry: Entry = existing ?? { host: key, source, state: 'identifying', lastAttempt: now, target };
    Object.assign(entry, { state: 'identifying', lastAttempt: now, lastSeen: source === 'discovery' ? now : entry.lastSeen });
    this.entries.set(key, entry);
    this.runtime.emit('dirty');

    // Sennheiser: a family that says so, or found by Sennheiser's discovery.
    if (target?.maker === 'sennheiser' || (target?.family && isSennheiser(target.family))) {
      await this.considerSennheiser(host, entry, target);
      this.runtime.emit('dirty');
      return;
    }

    // An explicit port is used as given. Otherwise try the family's own port
    // first (2201 for psm1000@host), then the rest of 2202 / 2201.
    const familyPort = target?.family ? defaultPort(target.family) : undefined;
    const ports = familyPort ? [familyPort, ...SHURE_PORTS.filter((p) => p !== familyPort)] : SHURE_PORTS;
    const id = target?.port ? await identifyShure(host, target.port) : await identifyShureOnPorts(host, ports);
    // Connect where the device actually answered.
    const port = target?.port ?? (id.reachable ? id.port : undefined);
    Object.assign(entry, { model: id.model, deviceId: id.deviceId || undefined, kind: target?.charger ? 'charger' : (target?.family ?? id.kind) });

    if (!id.reachable && !target?.family && !target?.charger) {
      // Not a Shure device: an address given by hand might be a Sennheiser one.
      if (source === 'manual' && !target?.port) {
        const sid = await identifySennheiser(host);
        if (sid.reachable) {
          await this.considerSennheiser(host, entry, target, sid);
          this.runtime.emit('dirty');
          return;
        }
      }
      Object.assign(entry, { state: 'unreachable', note: target?.port ? `No answer on port ${target.port}` : `No answer on port ${[...ports, SSC_PORT].join(', ')}` });
    } else if (target?.charger || id.kind === 'charger') {
      const chargerId = this.deviceName(id, 'SBC');
      this.runtime.addCharger({ id: chargerId, host, port });
      this.opts.known?.rememberCharger({ id: chargerId, host, port, model: id.model });
      // From here on the entry names the device as the runtime knows it (Forget, status).
      Object.assign(entry, { state: 'monitoring', note: undefined, deviceId: chargerId });
      this.log(`Monitoring charger ${id.model ?? ''} at ${host}`);
    } else if (target?.family || id.kind) {
      const family = (target?.family ?? id.kind) as ShureFamilyId;
      const name = this.deviceName(id, family.toUpperCase());
      this.runtime.addReceiver(
        { id: name, family, host, port, channels: target?.channels ?? id.channels },
        name,
      );
      this.opts.known?.rememberReceiver({ id: name, host, port, family, channels: target?.channels ?? id.channels, model: id.model });
      Object.assign(entry, {
        state: 'monitoring',
        deviceId: name,
        note: id.reachable ? undefined : 'Not answering yet; will keep trying',
      });
      this.log(`Monitoring ${id.model ?? family} at ${host}:${port ?? defaultPort(family)} (${target?.channels ?? id.channels ?? 'default'} channels)`);
    } else {
      Object.assign(entry, { state: 'unsupported', note: id.unsupported });
    }
    this.runtime.emit('dirty');
  }

  /**
   * Add every device found on an earlier run straight away. One that is
   * switched off shows as offline (its channels keep their last names) and
   * connects as soon as it answers.
   */
  private restoreKnown(): void {
    const known = this.opts.known?.list();
    if (!known) return;
    const now = Date.now();
    for (const r of known.receivers) {
      const key = r.port ? `${r.host}:${r.port}` : r.host;
      if (this.entries.has(key) || this.runtime.receivers.has(r.id)) continue;
      this.usedIds.add(r.id);
      this.entries.set(key, {
        host: key, source: 'remembered', state: 'monitoring', model: r.model, kind: r.family, deviceId: r.id,
        note: 'Remembered from before; waiting for it to answer', lastAttempt: now,
        target: { host: r.host, port: r.port, family: r.family, channels: r.channels },
      });
      this.runtime.addReceiver({ id: r.id, family: r.family, host: r.host, port: r.port, channels: r.channels }, r.id);
    }
    for (const c of known.chargers) {
      const key = c.port ? `${c.host}:${c.port}` : c.host;
      if (this.entries.has(key) || this.runtime.chargers.has(c.id)) continue;
      this.usedIds.add(c.id);
      this.entries.set(key, {
        host: key, source: 'remembered', state: 'monitoring', model: c.model, kind: 'charger', deviceId: c.id,
        note: 'Remembered from before; waiting for it to answer', lastAttempt: now, target: { host: c.host, port: c.port, charger: true },
      });
      this.runtime.addCharger({ id: c.id, host: c.host, port: c.port });
    }
    if (known.receivers.length + known.chargers.length) this.log(`Remembered ${known.receivers.length} receivers and ${known.chargers.length} chargers from before.`);
  }

  private saveNames(): void {
    const known = this.opts.known;
    if (!known) return;
    for (const rx of this.runtime.receivers.values()) {
      const names: Record<string, string> = {};
      for (const [ch, state] of rx.channels) if (state.telemetry.name.state === 'ok') names[String(ch)] = state.telemetry.name.value;
      if (Object.keys(names).length) known.setNames(rx.info.id, names);
    }
  }

  /**
   * Add a device by address (Devices, Add device), for networks where
   * discovery can't see it: the same forms as --receiver, e.g. "10.0.1.40",
   * "ewdx@10.0.1.40/4". Identifying carries on in the background; the
   * Devices list shows how it went. Returns the entry's key.
   */
  add(spec: string): string {
    const target = parseTarget(spec.trim());
    const key = target.port ? `${target.host}:${target.port}` : target.host;
    const existing = this.entries.get(key);
    // Asked again by hand: an unreachable one is tried again now.
    if (existing?.state === 'unreachable') existing.lastAttempt = 0;
    void this.consider(target.host, 'manual', target);
    return key;
  }

  /** Stop monitoring a device and stop remembering it (Devices, Forget). */
  forget(host: string): boolean {
    const entry = this.entries.get(host);
    const id = entry?.deviceId;
    const forgotten = this.opts.known?.forget(host) ?? false;
    if (!entry && !forgotten) return false;
    if (id) {
      this.runtime.removeDevice(id);
      this.usedIds.delete(id);
    }
    this.entries.delete(host);
    this.runtime.emit('dirty');
    return true;
  }

  /** A Sennheiser SSC device: identify it (unless already done) and monitor it if it's a supported receiver. */
  private async considerSennheiser(host: string, entry: Entry, target?: LiveTarget, known?: SscIdentity): Promise<void> {
    const sid = known ?? (await identifySennheiser(host, target?.port));
    const family = target?.family && isSennheiser(target.family) ? target.family : 'family' in sid ? sid.family : undefined;
    Object.assign(entry, { model: sid.product, deviceId: sid.deviceName || undefined, kind: family });
    if (!sid.reachable && !family) {
      Object.assign(entry, { state: 'unreachable', note: `No answer on SSC port ${target?.port ?? SSC_PORT}. On EW-DX, turn on 3rd party access (Legacy SSCv1) in Control Cockpit.` });
      return;
    }
    if (!family) {
      Object.assign(entry, { state: 'unsupported', note: sid.unsupported });
      return;
    }
    const name = this.deviceName({ host, reachable: sid.reachable, deviceId: sid.deviceName, model: sid.product }, family.toUpperCase());
    const channels = target?.channels ?? sid.channels;
    this.runtime.addReceiver({ id: name, family, host, port: target?.port, channels }, name);
    this.opts.known?.rememberReceiver({ id: name, host, port: target?.port, family, channels, model: sid.product });
    Object.assign(entry, { state: 'monitoring', deviceId: name, note: sid.reachable ? undefined : 'Not answering yet; will keep trying' });
    this.log(`Monitoring ${sid.product ?? family} at ${host}:${target?.port ?? SSC_PORT} (${channels ?? 'default'} channels)`);
  }

  /** Prefer the name engineers gave the device in Wireless Workbench. */
  private deviceName(id: Identity, fallback: string): string {
    const octet = id.host.split('.').pop();
    const base = id.deviceId?.trim() || `${id.model ?? fallback} .${octet}`;
    let name = base;
    for (let n = 2; this.usedIds.has(name); n++) name = `${base} (${n})`;
    this.usedIds.add(name);
    return name;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }
}
