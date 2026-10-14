import { ShureDiscovery } from '../adapters/shure/discovery.js';
import { SHURE_PORTS } from '../adapters/shure/connection.js';
import { SHURE_FAMILIES, SHURE_FAMILY_IDS as FAMILIES, type ShureFamilyId } from '../adapters/shure/families.js';
import { identifyShure, identifyShureOnPorts, type Identity } from '../adapters/shure/identify.js';
import type { Runtime } from './runtime.js';
import type { DiscoveredView } from './snapshot.js';

export interface LiveTarget {
  host: string;
  port?: number;
  family?: ShureFamilyId;
  channels?: number;
  charger?: boolean;
}

/**
 * Parse a command-line device: `[family@]host[:port][/channels]`, e.g.
 * `10.0.1.20`, `axd@10.0.1.20`, `ulxd@10.0.1.21/2`, `psm1000@10.0.1.30`, `127.0.0.1:22020`.
 */
export function parseTarget(spec: string, charger = false): LiveTarget {
  const m = /^(?:(\w+)@)?([^:/@\s]+)(?::(\d+))?(?:\/(\d+))?$/.exec(spec.trim());
  if (!m) throw new Error(`Can't read device "${spec}". Use [family@]host[:port][/channels], e.g. axd@10.0.1.20`);
  const [, family, host, port, channels] = m;
  if (family && !FAMILIES.includes(family as ShureFamilyId)) {
    throw new Error(`Unknown family "${family}" in "${spec}". Use one of: ${FAMILIES.join(', ')}`);
  }
  return {
    host: host!,
    port: port ? Number(port) : undefined,
    family: family as ShureFamilyId | undefined,
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
  private retryTimer: NodeJS.Timeout | undefined;
  private usedIds = new Set<string>();
  discoveryError: string | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly opts: { discover: boolean; targets: LiveTarget[]; log?: (msg: string) => void; onPacket?: (ip: string, text: string) => void },
  ) {
    runtime.discovered = () =>
      [...this.entries.values()]
        .map(({ target: _t, lastAttempt: _a, ...view }) => view)
        .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
  }

  async start(): Promise<void> {
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
    }

    // Retry devices that were named on the command line but didn't answer.
    this.retryTimer = setInterval(() => {
      for (const e of this.entries.values()) {
        if (e.state === 'unreachable' && e.source === 'manual') void this.consider(e.target?.host ?? e.host, 'manual', e.target);
      }
    }, RETRY_MS);
  }

  stop(): void {
    clearInterval(this.retryTimer);
    this.discovery?.stop();
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

    // An explicit port is used as given. Otherwise try the family's own port
    // first (2201 for psm1000@host), then the rest of 2202 / 2201.
    const familyPort = target?.family ? SHURE_FAMILIES[target.family].defaultPort : undefined;
    const ports = familyPort ? [familyPort, ...SHURE_PORTS.filter((p) => p !== familyPort)] : SHURE_PORTS;
    const id = target?.port ? await identifyShure(host, target.port) : await identifyShureOnPorts(host, ports);
    // Connect where the device actually answered.
    const port = target?.port ?? (id.reachable ? id.port : undefined);
    Object.assign(entry, { model: id.model, deviceId: id.deviceId || undefined, kind: target?.charger ? 'charger' : (target?.family ?? id.kind) });

    if (!id.reachable && !target?.family && !target?.charger) {
      Object.assign(entry, { state: 'unreachable', note: target?.port ? `No answer on port ${target.port}` : `No answer on port ${ports.join(' or ')}` });
    } else if (target?.charger || id.kind === 'charger') {
      this.runtime.addCharger({ id: this.deviceName(id, 'SBC'), host, port });
      Object.assign(entry, { state: 'monitoring', note: undefined });
      this.log(`Monitoring charger ${id.model ?? ''} at ${host}`);
    } else if (target?.family || id.kind) {
      const family = (target?.family ?? id.kind) as ShureFamilyId;
      const name = this.deviceName(id, family.toUpperCase());
      this.runtime.addReceiver(
        { id: name, family, host, port, channels: target?.channels ?? id.channels },
        name,
      );
      Object.assign(entry, {
        state: 'monitoring',
        note: id.reachable ? undefined : 'Not answering yet; will keep trying',
      });
      this.log(`Monitoring ${id.model ?? family} at ${host}:${port ?? SHURE_FAMILIES[family].defaultPort} (${target?.channels ?? id.channels ?? 'default'} channels)`);
    } else {
      Object.assign(entry, { state: 'unsupported', note: id.unsupported });
    }
    this.runtime.emit('dirty');
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
