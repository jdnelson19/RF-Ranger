import { EventEmitter } from 'node:events';
import { ShureCharger } from '../adapters/shure/charger.js';
import { ShureReceiver } from '../adapters/shure/receiver.js';
import { channelAlerts } from '../core/alerts.js';
import { emptyTelemetry } from '../core/model.js';
import { readiness } from '../core/readiness.js';
import type { Config } from './config.js';
import type { Snapshot, SlotView } from './snapshot.js';

interface Events {
  /** Device state changed; consumers should throttle snapshot rebuilds. */
  dirty: [];
}

/** Owns every device connection and builds the single source of truth for both views. */
export class Runtime extends EventEmitter<Events> {
  readonly receivers = new Map<string, ShureReceiver>();
  readonly chargers = new Map<string, ShureCharger>();

  constructor(readonly config: Config, readonly demo = false) {
    super();
    const dirty = () => this.emit('dirty');

    for (const rc of config.receivers) {
      const usedChannels = config.slots.filter((s) => s.receiver === rc.id).map((s) => s.channel);
      const rx = new ShureReceiver({
        id: rc.id,
        host: rc.host,
        port: rc.port,
        family: rc.family,
        channels: rc.channels ?? (usedChannels.length ? Math.max(...usedChannels) : undefined),
      });
      rx.on('channel', dirty).on('status', dirty).on('info', dirty);
      this.receivers.set(rc.id, rx);
    }

    for (const cc of config.chargers) {
      const charger = new ShureCharger({ id: cc.id, host: cc.host, port: cc.port });
      charger.on('bay', dirty).on('status', dirty).on('info', dirty);
      this.chargers.set(cc.id, charger);
    }
  }

  start(): void {
    for (const d of [...this.receivers.values(), ...this.chargers.values()]) d.start();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.receivers.values(), ...this.chargers.values()].map((d) => d.stop()));
  }

  snapshot(now = Date.now()): Snapshot {
    const th = this.config.thresholds;

    const slots = [...this.config.slots]
      .sort((a, b) => a.slot - b.slot)
      .map((s): SlotView => {
        const rx = this.receivers.get(s.receiver)!;
        const telemetry = rx.channels.get(s.channel)?.telemetry ?? emptyTelemetry();
        const a = s.assignment;
        const charger = a?.charger ? this.chargers.get(a.charger.id) : undefined;
        const bay = charger && a?.charger ? charger.bays.get(a.charger.bay) : undefined;

        const ready = readiness(
          {
            assigned: a !== undefined,
            connection: rx.status,
            telemetry,
            expectedTxDeviceId: a?.expectedTxId,
            storage: charger ? { connection: charger.status, bay, storageMode: charger.info.storageMode } : undefined,
            now,
          },
          th,
        );

        return {
          slot: s.slot,
          label: s.label ?? String(s.slot),
          kind: s.kind,
          group: s.group,
          receiverId: s.receiver,
          channel: s.channel,
          family: rx.family.id,
          telemetry,
          assignment: a && { ...a, photoUrl: photoUrl(a.photo) },
          bay,
          readiness: ready,
          alerts: channelAlerts(
            { assigned: a !== undefined, connection: rx.status, telemetry, readiness: ready, expectedTxDeviceId: a?.expectedTxId, now },
            th,
          ),
        };
      });

    const listed = this.config.groups;
    const extra = [...new Set(slots.map((s) => s.group).filter((g): g is string => !!g && !listed.includes(g)))].sort();

    return {
      demo: this.demo,
      serverTime: now,
      groups: [...listed, ...extra],
      slots,
      receivers: [...this.receivers.values()].map((r) => ({ info: r.info, status: r.status })),
      chargers: [...this.chargers.values()].map((c) => ({
        info: c.info,
        status: c.status,
        bays: Object.fromEntries(c.bays),
      })),
    };
  }
}

function photoUrl(photo: string | undefined): string | undefined {
  if (!photo) return undefined;
  return /^https?:\/\//.test(photo) ? photo : `/photos/${encodeURIComponent(photo)}`;
}
