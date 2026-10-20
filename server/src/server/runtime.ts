import { EventEmitter } from 'node:events';
import { ShureCharger } from '../adapters/shure/charger.js';
import { ShureReceiver } from '../adapters/shure/receiver.js';
import { channelAlerts } from '../core/alerts.js';
import { splitChannelName, type AssignmentConfig, type SlotConfig } from '../core/assignment.js';
import { namesPerson, type LiveNow } from '../core/live.js';
import { EMPTY_ROSTER, type Roster } from '../core/mic-roster.js';
import { emptyTelemetry, type ChannelTelemetry } from '../core/model.js';
import { readiness, txPresent } from '../core/readiness.js';
import type { ChargerConfig, Config, ReceiverConfig } from './config.js';
import { VERSION } from '../version.js';
import type { DiscoveredView, RunMode, ShowPreset, Snapshot, SlotView } from './snapshot.js';

interface Events {
  /** Device state changed; consumers should throttle snapshot rebuilds. */
  dirty: [];
}

/** Owns every device connection and builds the single source of truth for both views. */
export class Runtime extends EventEmitter<Events> {
  readonly receivers = new Map<string, ShureReceiver>();
  readonly chargers = new Map<string, ShureCharger>();
  /** Set by live mode to report what discovery has found. */
  discovered: () => DiscoveredView[] = () => [];
  /** Set at startup to share show presets with every screen. */
  presets: () => ShowPreset[] = () => [];
  /** Set at startup: this service's mic assignments from Planning Center (see core/mic-roster.ts). */
  roster: () => Roster = () => EMPTY_ROSTER;
  /** Set at startup: what is live in Planning Center Services Live. */
  live: () => LiveNow | undefined = () => undefined;
  /** Set at startup: a newer version, once one is found. */
  update: () => Snapshot['update'] = () => undefined;
  /** Running as the desktop app (offers Quit in the UI). */
  app = false;
  private running = false;

  constructor(readonly config: Config, readonly mode: RunMode = 'config') {
    super();
    for (const rc of config.receivers) this.createReceiver(rc);
    for (const cc of config.chargers) this.createCharger(cc);
  }

  /** Add a receiver while running, with one auto-named slot per channel. */
  addReceiver(rc: ReceiverConfig, group?: string): void {
    if (this.receivers.has(rc.id)) return;
    this.config.receivers.push(rc);
    const rx = this.createReceiver(rc);
    let next = Math.max(0, ...this.config.slots.map((s) => s.slot)) + 1;
    const kind = rx.family.role === 'iem' ? 'iem' : undefined;
    for (const ch of rx.channels.keys()) {
      this.config.slots.push({ slot: next++, receiver: rc.id, channel: ch, kind, group, autoName: true });
    }
    if (this.running) rx.start();
    this.emit('dirty');
  }

  addCharger(cc: ChargerConfig): void {
    if (this.chargers.has(cc.id)) return;
    this.config.chargers.push(cc);
    const c = this.createCharger(cc);
    if (this.running) c.start();
    this.emit('dirty');
  }

  start(): void {
    this.running = true;
    for (const d of [...this.receivers.values(), ...this.chargers.values()]) d.start();
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all([...this.receivers.values(), ...this.chargers.values()].map((d) => d.stop()));
  }

  private createReceiver(rc: ReceiverConfig): ShureReceiver {
    const usedChannels = this.config.slots.filter((s) => s.receiver === rc.id).map((s) => s.channel);
    const rx = new ShureReceiver({
      id: rc.id,
      host: rc.host,
      port: rc.port,
      family: rc.family,
      channels: rc.channels ?? (usedChannels.length ? Math.max(...usedChannels) : undefined),
    });
    const dirty = () => this.emit('dirty');
    rx.on('channel', dirty).on('status', dirty).on('info', dirty);
    this.receivers.set(rc.id, rx);
    return rx;
  }

  private createCharger(cc: ChargerConfig): ShureCharger {
    const charger = new ShureCharger({ id: cc.id, host: cc.host, port: cc.port });
    const dirty = () => this.emit('dirty');
    charger.on('bay', dirty).on('status', dirty).on('info', dirty);
    this.chargers.set(cc.id, charger);
    return charger;
  }

  snapshot(now = Date.now()): Snapshot {
    const th = this.config.thresholds;
    const roster = this.roster();

    const slots = [...this.config.slots]
      .sort((a, b) => a.slot - b.slot)
      .map((s): SlotView => {
        const rx = this.receivers.get(s.receiver)!;
        const state = rx.channels.get(s.channel);
        const telemetry = state?.telemetry ?? emptyTelemetry();
        const key = `${s.receiver}/${s.channel}`;
        const named = s.autoName ? fromChannelName(s, telemetry) : { label: s.label ?? String(s.slot), assignment: s.assignment };
        const label = named.label;
        // This service's Planning Center roster names who is on the mic; the
        // configured charger bay and expected transmitter still apply.
        const scheduled = roster.entries[key];
        const a: AssignmentConfig | undefined = scheduled
          ? { ...named.assignment, artist: scheduled.name, role: scheduled.role, photo: scheduled.photoUrl }
          : named.assignment;
        const charger = a?.charger ? this.chargers.get(a.charger.id) : undefined;
        const bay = charger && a?.charger ? charger.bays.get(a.charger.bay) : undefined;

        const role = rx.family.role;
        const ready = readiness(
          {
            assigned: a !== undefined,
            role,
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
          key,
          label,
          kind: s.kind,
          group: s.group,
          receiverId: s.receiver,
          channel: s.channel,
          family: rx.family.id,
          role,
          txOn: role === 'mic' && txPresent(telemetry),
          telemetry,
          levels: role === 'mic' ? state?.levels.bins(now) : undefined,
          assignment: a && {
            ...a,
            photoUrl: photoUrl(a.photo),
            ...(scheduled ? { planningCenter: { unconfirmed: !!scheduled.unconfirmed, edited: scheduled.source === 'manual' } } : {}),
          },
          bay,
          readiness: ready,
          alerts: channelAlerts(
            { assigned: a !== undefined, role, connection: rx.status, telemetry, readiness: ready, expectedTxDeviceId: a?.expectedTxId, now },
            th,
          ),
        };
      });

    // Light up whoever the live item's Leader note names.
    const live = this.live();
    if (live?.leader) {
      const names = slots.map((x) => x.assignment?.artist).filter((x): x is string => !!x);
      for (const x of slots) if (x.assignment && namesPerson(live.leader, x.assignment.artist, names)) x.leading = true;
    }

    const listed = this.config.groups;
    const extra = [...new Set(slots.map((s) => s.group).filter((g): g is string => !!g && !listed.includes(g)))].sort();

    return {
      demo: this.mode === 'demo',
      mode: this.mode,
      app: this.app,
      version: VERSION,
      serverTime: now,
      groups: [...listed, ...extra],
      slots,
      receivers: [...this.receivers.values()].map((r) => ({ info: r.info, status: r.status })),
      chargers: [...this.chargers.values()].map((c) => ({
        info: c.info,
        status: c.status,
        bays: Object.fromEntries(c.bays),
      })),
      discovered: this.discovered(),
      presets: this.presets(),
      update: this.update(),
      live,
    };
  }
}

function fromChannelName(s: SlotConfig, t: ChannelTelemetry): { label: string; assignment?: AssignmentConfig } {
  const raw = t.name.state === 'ok' ? t.name.value : '';
  const { id, name } = splitChannelName(raw);
  return { label: id ?? String(s.slot), assignment: name ? { artist: name } : undefined };
}

function photoUrl(photo: string | undefined): string | undefined {
  if (!photo) return undefined;
  return /^https?:\/\//.test(photo) ? photo : `/photos/${encodeURIComponent(photo)}`;
}
