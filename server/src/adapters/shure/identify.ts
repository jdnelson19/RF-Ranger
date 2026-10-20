import net from 'node:net';
import { SHURE_FAMILY_IDS, type ShureFamilyId } from './families.js';
import { ShureFramer, parseMessage } from './protocol.js';
import { SHURE_PORT, SHURE_PORTS } from './connection.js';

export type ShureKind = ShureFamilyId | 'charger';

export interface Identity {
  host: string;
  /** The control port that was tried (the one that answered, when reachable). */
  port?: number;
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
  [/^P10T/i, 'psm1000'],
  [/^ADT[DQ]/i, 'Axient Digital PSM transmitters are not supported yet'],
  [/^PSM/i, 'This in-ear monitor transmitter is not supported yet'],
];

const KINDS: readonly string[] = [...SHURE_FAMILY_IDS, 'charger'];

export function kindForModel(model: string): { kind?: ShureKind; unsupported?: string } {
  for (const [re, k] of MODEL_KINDS) {
    if (re.test(model)) return KINDS.includes(k) ? { kind: k as ShureKind } : { unsupported: k };
  }
  return { unsupported: `Unrecognised model "${model}"` };
}

/**
 * Ask a device on the Shure control port what it is. Read-only: only GETs are
 * sent, and the connection is closed straight away.
 *
 * Older ULX-D firmware documents no MODEL command, so if MODEL isn't
 * answered, family-only queries are used as a fallback: HIGH_DENSITY
 * (ULX-D) and AUDIO_TX_MODE (PSM 1000 P10T). The P10T only listens to
 * commands ending in "\r\n", so the fallback is sent that way too; it also
 * streams AUDIO_IN_LVL reports unasked, which identify it on their own.
 */
export async function identifyShure(host: string, port = SHURE_PORT, timeoutMs = 2_500): Promise<Identity> {
  return new Promise((resolve) => {
    const id: Identity = { host, port, reachable: false };
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
      socket.write('< GET MODEL >< GET DEVICE_ID >< GET DEVICE_NAME >< GET 0 CHAN_NAME >< GET 0 BATT_DETECTED >');
      // If MODEL hasn't arrived shortly, try the family fallbacks.
      setTimeout(() => {
        if (!id.model && !finished && !socket.destroyed) {
          fallbackSent = true;
          socket.write('< GET HIGH_DENSITY >< GET 1 AUDIO_TX_MODE >< GET 2 CHAN_NAME >');
          askP10t();
        }
      }, 600);
    });
    let p10tAsked = false;
    const askP10t = () => {
      if (p10tAsked || finished || socket.destroyed) return;
      p10tAsked = true;
      socket.write('\r\n< GET MODEL >\r\n< GET DEVICE_NAME >\r\n< GET 1 AUDIO_TX_MODE >\r\n< GET 1 CHAN_NAME >\r\n< GET 2 CHAN_NAME >\r\n');
    };
    let doneTimer: NodeJS.Timeout | undefined;
    socket.on('error', finish);
    socket.on('close', finish);
    socket.on('data', (chunk: string) => {
      for (const frame of framer.push(chunk)) {
        const m = parseMessage(frame);
        if (m.kind !== 'rep') continue;
        if (m.channel === undefined) {
          const v = m.args.join(' ');
          if (m.key === 'MODEL' && v) Object.assign(id, { model: v }, kindForModel(v));
          else if (m.key === 'DEVICE_ID' || (m.key === 'DEVICE_NAME' && !id.deviceId)) id.deviceId = v;
          else if (m.key === 'HIGH_DENSITY' && fallbackSent && !id.model) {
            id.kind = 'ulxd';
            id.model = 'ULX-D';
          }
        } else if (/^AUDIO_IN_LVL/.test(m.key)) {
          // Only the P10T streams AUDIO_IN_LVL_L/R. Ask its name the way it listens (with "\r\n").
          channelsSeen.add(m.channel);
          if (!id.kind) {
            id.kind = 'psm1000';
            id.model ??= 'P10T';
            askP10t();
          }
        } else if (m.key === 'AUDIO_TX_MODE' && (fallbackSent || p10tAsked) && (!id.model || id.kind === 'psm1000')) {
          // Only the P10T has AUDIO_TX_MODE.
          id.kind = 'psm1000';
          id.model ??= 'P10T';
          channelsSeen.add(m.channel);
        } else if (m.key === 'CHAN_NAME' || m.key === 'BATT_DETECTED') {
          channelsSeen.add(m.channel);
        }
      }
      // Done once we know what it is and channels have had a moment to answer.
      // A P10T recognised by its meters gets longer, so its name can arrive.
      if ((id.kind || id.unsupported) && !doneTimer) {
        clearTimeout(timer);
        doneTimer = setTimeout(finish, p10tAsked && !id.deviceId ? 900 : 400);
      }
    });
  });
}

/**
 * Identify a device whose control port isn't known: try each port in turn
 * (2202, then the PSM 1000's 2201) and keep the first that answers. A
 * refused connection is quick, so a P10T costs well under a second extra.
 */
export async function identifyShureOnPorts(host: string, ports: readonly number[] = SHURE_PORTS, timeoutMs = 2_500): Promise<Identity> {
  let last: Identity = { host, port: ports[0], reachable: false };
  for (const port of ports) {
    const id = await identifyShure(host, port, timeoutMs);
    if (id.reachable) {
      if (!id.kind && id.unsupported?.startsWith('Did not identify')) {
        id.unsupported = `Answered on port ${port} but didn't identify. If it's a PSM 1000, add it as psm1000@${host} and send a Device Inspector report.`;
      }
      return id;
    }
    last = id;
  }
  return last;
}
