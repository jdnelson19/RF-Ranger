import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import os from 'node:os';

/** Shure devices announce themselves with SLP on this multicast group. */
export const SLP_GROUP = '239.255.254.253';
export const SLP_PORT = 8427;

export interface Sighting {
  ip: string;
  firstSeen: number;
  lastSeen: number;
  /** Device Class ID from the announcement, if one was found. */
  dcid?: string;
  packets: number;
}

interface Events {
  /** A device announced itself for the first time. */
  found: [Sighting];
  /** Every packet, for logging while the format is being validated. */
  packet: [ip: string, text: string];
  error: [Error];
}

/**
 * Passive SLP listener. Announcements only tell us that *something* is at an
 * address; what it is gets confirmed over the control port (identify.ts).
 *
 * Unlike Micboard, this binds the wildcard address with address reuse and
 * joins the group on every IPv4 interface, which works on Windows and on
 * machines with several network cards (e.g. Wi-Fi plus a production LAN).
 */
export class ShureDiscovery extends EventEmitter<Events> {
  readonly seen = new Map<string, Sighting>();
  private socket: dgram.Socket | undefined;

  constructor(private readonly port = SLP_PORT, private readonly group = SLP_GROUP) {
    super();
  }

  /** Resolves once listening; on failure it emits `error` and resolves `false`. */
  start(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      let bound = false;
      socket.on('error', (err) => {
        this.emit('error', err);
        if (!bound) resolve(false);
      });
      socket.on('message', (msg, rinfo) => this.handle(rinfo.address, msg));
      socket.bind(this.port, () => {
        bound = true;
        for (const addr of ipv4Interfaces()) {
          try {
            socket.addMembership(this.group, addr);
          } catch (err) {
            this.emit('error', new Error(`Could not listen for discovery on ${addr}: ${(err as Error).message}`));
          }
        }
        resolve(true);
      });
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /** Exposed for tests. */
  handle(ip: string, msg: Buffer, now = Date.now()): void {
    const text = msg.toString('latin1').replace(/[^\x20-\x7e]+/g, ' ');
    this.emit('packet', ip, text);
    const dcid = findDcid(text);
    const existing = this.seen.get(ip);
    if (existing) {
      existing.lastSeen = now;
      existing.packets++;
      existing.dcid ??= dcid;
      return;
    }
    const s: Sighting = { ip, firstSeen: now, lastSeen: now, dcid, packets: 1 };
    this.seen.set(ip, s);
    this.emit('found', s);
  }
}

/** Micboard reads the device class from a `cd:` token in the announcement. */
export function findDcid(text: string): string | undefined {
  const m = /cd:([0-9A-Za-z-]+)/.exec(text);
  return m?.[1];
}

function ipv4Interfaces(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
