/**
 * Ask a device on the SSC port what it is. Read-only: one request for the
 * device name and identity; nothing is subscribed or changed.
 */
import dgram from 'node:dgram';
import { familyForProduct, type SennheiserFamilyId } from './families.js';
import { SSC_PORT, leaves, merge, tree, type SscValue } from './ssc.js';

export interface SscIdentity {
  host: string;
  port: number;
  reachable: boolean;
  product?: string;
  deviceName?: string;
  version?: string;
  family?: SennheiserFamilyId;
  channels?: number;
  unsupported?: string;
}

const QUERY = merge(tree(['device', 'name']), tree(['device', 'identity', 'product']), tree(['device', 'identity', 'version']));

export function identifySennheiser(host: string, port = SSC_PORT, timeoutMs = 2_000): Promise<SscIdentity> {
  return new Promise((resolve) => {
    const id: SscIdentity = { host, port, reachable: false };
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (id.product) Object.assign(id, familyForProduct(id.product));
      else if (id.reachable) id.unsupported = 'Answered on the SSC port without a product name';
      resolve(id);
    };
    const timer = setTimeout(done, timeoutMs);
    socket.on('error', done);
    socket.on('message', (buf, rinfo) => {
      if (rinfo.address !== host) return;
      let msg: Record<string, SscValue>;
      try {
        msg = JSON.parse(buf.toString('utf8')) as Record<string, SscValue>;
      } catch {
        return;
      }
      id.reachable = true;
      for (const [path, v] of leaves(msg)) {
        if (typeof v !== 'string') continue;
        if (path === '/device/identity/product') id.product = v.trim();
        else if (path === '/device/name') id.deviceName = v.trim();
        else if (path === '/device/identity/version') id.version = v.trim();
      }
      if (id.product) done();
    });
    socket.bind(0, () => socket.send(JSON.stringify(QUERY), port, host));
  });
}
