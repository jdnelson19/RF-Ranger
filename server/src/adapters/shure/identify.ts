import net from 'node:net';
import type { ShureFamilyId } from './families.js';
import { ShureFramer, parseMessage } from './protocol.js';
import { SHURE_PORT } from './connection.js';

export type ShureKind = ShureFamilyId | 'charger';

export interface Identity {
  host: string;
  /** False when nothing answered on the control port. */
  reachable: boolean;
  model?: string;
  deviceId?: string;
  kind?: ShureKind;
  /** Channels (receivers) or bays (chargers) that answered. */
  channels?: number;
  /** Why the device can't be monitored, when it can't. */
  unsupported?: string;
}

/** Model-name prefixes to device kinds. Order matters: longer prefixes first. */
const MODEL_KINDS: Array<[RegExp, ShureKind | string]> = [
  [/^ULXD4/i, 'ulxd'],
  [/^AD4/i, 'axd'],
  [/^AD610/i, 'axd'],
  [/^SLXD4/i, 'slxd'],
  [/^SBC2[24]0/i, 'charger'],
  [/^QLXD/i, 'QLX-D is not supported yet'],
  [/^SBC[48]50/i, 'SBC450/SBC850 chargers are not supported yet'],
  [/^SBC/i, 'This charger model is not supported yet'],
  [/^(P10T|PSM)/i, 'In-ear monitor transmitters are not supported yet'],
];

export function kindForModel(model: string): { kind?: ShureKind; unsupported?: string } {
  for (const [re, k] of MODEL_KINDS) {
    if (re.test(model)) {
      return ['ulxd', 'axd', 'slxd', 'charger'].includes(k) ? { kind: k as ShureKind } : { unsupported: k };
    }
  }
  return { unsupported: `Unrecognised model "${model}"` };
}

/**
 * Ask a device on the Shure control port what it is. Read-only: only GETs are
 * sent, and the connection is closed straight away.
 *
 * Older ULX-D firmware documents no MODEL command, so if MODEL isn't
 * answered, a ULX-D-only query (HIGH_DENSITY) is used as a fallback.
 */
export async function identifyShure(host: string, port = SHURE_PORT, timeoutMs = 2_500): Promise<Identity> {
  return new Promise((resolve) => {
    const id: Identity = { host, reachable: false };
    const channelsSeen = new Set<number>();
    const framer = new ShureFramer();
    const socket = net.connect({ host, port });
    socket.setEncoding('ascii');
    let fallbackSent = false;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (channelsSeen.size) id.channels = Math.max(...channelsSeen);
      if (id.reachable && !id.kind && !id.unsupported) id.unsupported = 'Did not identify as a supported Shure device';
      resolve(id);
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.once('connect', () => {
      id.reachable = true;
      socket.write('< GET MODEL >< GET DEVICE_ID >< GET 0 CHAN_NAME >< GET 0 BATT_DETECTED >');
      // If MODEL hasn't arrived shortly, try the ULX-D fallback.
      setTimeout(() => {
        if (!id.model && !finished && !socket.destroyed) {
          fallbackSent = true;
          socket.write('< GET HIGH_DENSITY >');
        }
      }, 600);
    });
    socket.on('error', finish);
    socket.on('close', finish);
    socket.on('data', (chunk: string) => {
      for (const frame of framer.push(chunk)) {
        const m = parseMessage(frame);
        if (m.kind !== 'rep') continue;
        if (m.channel === undefined) {
          const v = m.args.join(' ');
          if (m.key === 'MODEL' && v) Object.assign(id, { model: v }, kindForModel(v));
          else if (m.key === 'DEVICE_ID') id.deviceId = v;
          else if (m.key === 'HIGH_DENSITY' && fallbackSent && !id.model) {
            id.kind = 'ulxd';
            id.model = 'ULX-D';
          }
        } else if (m.key === 'CHAN_NAME' || m.key === 'BATT_DETECTED') {
          channelsSeen.add(m.channel);
        }
      }
      // Done once we know what it is and channels have had a moment to answer.
      if (id.kind || id.unsupported) {
        clearTimeout(timer);
        setTimeout(finish, 400);
      }
    });
  });
}
