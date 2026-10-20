/**
 * Find Sennheiser SSC devices on the local network. They advertise the
 * DNS-SD service "_ssc._udp" over mDNS (SSC developer guides, "SSC Server
 * Discovery"). Every 30 s this sends a one-shot mDNS query for that service
 * from an ordinary port, so responders answer straight back to it (RFC 6762
 * §6.7) and nothing needs to bind port 5353, which the operating system's
 * own mDNS service usually holds. Any device that answers is reported once
 * per answer; identify.ts then asks it what it is.
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_ssc._udp.local';
const QUERY_EVERY_MS = 30_000;

interface Events {
  found: [ip: string];
  error: [Error];
}

/** A DNS query for PTR `_ssc._udp.local`. */
export function sscQuery(): Buffer {
  const labels = SERVICE.split('.').flatMap((l) => [Buffer.from([l.length]), Buffer.from(l, 'ascii')]);
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // id 0, standard query, 1 question
  const tail = Buffer.from([0, 0, 12, 0, 1]); // root label, type PTR, class IN
  return Buffer.concat([header, ...labels, tail]);
}

/** Whether an mDNS response mentions the SSC service. */
export function mentionsSsc(packet: Buffer): boolean {
  if (packet.length < 12 || (packet[2]! & 0x80) === 0) return false; // must be a response
  return packet.includes(Buffer.from([4, ...Buffer.from('_ssc', 'ascii')]));
}

export class SscDiscovery extends EventEmitter<Events> {
  private socket: dgram.Socket | undefined;
  private timer: NodeJS.Timeout | undefined;

  start(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      socket.on('message', (buf, rinfo) => {
        if (mentionsSsc(buf)) this.emit('found', rinfo.address);
      });
      socket.on('error', (err) => {
        this.emit('error', err);
        resolve(false);
      });
      socket.bind(0, () => {
        const ask = () => socket.send(sscQuery(), MDNS_PORT, MDNS_ADDR, (err) => err && this.emit('error', err));
        ask();
        this.timer = setInterval(ask, QUERY_EVERY_MS);
        resolve(true);
      });
    });
  }

  stop(): void {
    clearInterval(this.timer);
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
  }
}
