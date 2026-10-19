import net from 'node:net';
import { AUDIO_TRIM_DB, type ShureFamilyId } from '../adapters/shure/families.js';
import { ShureFramer, parseMessage, tokenize } from '../adapters/shure/protocol.js';

/**
 * A fake Shure receiver speaking the third-party TCP protocol, for tests and
 * development without hardware. It is not a source of demo telemetry for the
 * UI: anything it produces is still "live" from RF Ranger's point of view.
 */

export interface SimChannel {
  name: string;
  frequencyKhz: number;
  txOn: boolean;
  txModel: string;
  txDeviceId: string;
  batteryBars: number;
  batteryPercent?: number;
  runtimeMin?: number;
  txOffsetDb: number;
  rfDbm: number;
  audioDbfs: number;
  rxMuted: boolean;
  /** IEM transmitters only. */
  rfOutputMw: number;
  rfMuted: boolean;
  /** PSM 1000 AUDIO_TX_MODE code: 1 mono, 2 point to point, 3 stereo. */
  audioMode: number;
}

export interface ShureSimOptions {
  family: ShureFamilyId;
  model?: string;
  channels?: Partial<SimChannel>[];
  /** Split outgoing writes at random points to exercise client framing. */
  fragment?: boolean;
  /** Older ULX-D firmware documents no MODEL command. */
  answersModel?: boolean;
  deviceId?: string;
}

const DEFAULT_MODEL: Record<ShureFamilyId, string> = { ulxd: 'ULXD4Q', axd: 'AD4Q-A', slxd: 'SLXD4D', psm1000: 'P10T' };
const DEFAULT_TX: Record<ShureFamilyId, string> = { ulxd: 'ULXD2', axd: 'AD2', slxd: 'SLXD2', psm1000: '' };

const pad = (n: number, width: number) => String(Math.max(0, Math.round(n))).padStart(width, '0');

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export class ShureSim {
  readonly family: ShureFamilyId;
  readonly model: string;
  readonly channels: SimChannel[];
  private server = net.createServer((s) => this.onClient(s));
  private clients = new Map<net.Socket, { meterTimers: Map<number, NodeJS.Timeout> }>();
  private fragment: boolean;
  private answersModel: boolean;
  private deviceId: string;

  constructor(opts: ShureSimOptions) {
    this.family = opts.family;
    this.model = opts.model ?? DEFAULT_MODEL[opts.family];
    this.fragment = opts.fragment ?? false;
    this.answersModel = opts.answersModel ?? true;
    this.deviceId = opts.deviceId ?? 'SIM';
    const count = opts.channels?.length ?? (opts.family === 'slxd' || opts.family === 'psm1000' ? 2 : 4);
    this.channels = Array.from({ length: count }, (_, i) => ({
      name: `CH ${i + 1}`,
      frequencyKhz: 470_125 + i * 1_000,
      txOn: true,
      txModel: DEFAULT_TX[opts.family],
      txDeviceId: '',
      batteryBars: 5,
      txOffsetDb: 0,
      rfDbm: -60,
      audioDbfs: -30,
      rxMuted: false,
      rfOutputMw: 50,
      rfMuted: false,
      audioMode: 3,
      ...definedOnly(opts.channels?.[i] ?? {}),
    }));
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(port, host, resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  /** Abruptly drops all clients, like a receiver losing power or network. */
  dropClients(): void {
    for (const s of this.clients.keys()) s.destroy();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Change a channel and push REPORTs for it, as a real receiver does. */
  update(channel: number, patch: Partial<SimChannel>): void {
    const ch = this.channels[channel - 1];
    if (!ch) throw new Error(`No channel ${channel}`);
    Object.assign(ch, patch);
    for (const s of this.clients.keys()) this.write(s, this.channelReports(channel).join(''));
  }

  private onClient(socket: net.Socket): void {
    const state = { meterTimers: new Map<number, NodeJS.Timeout>() };
    this.clients.set(socket, state);
    const framer = new ShureFramer();
    socket.setEncoding('ascii');
    socket.on('data', (chunk: string) => {
      for (const frame of framer.push(chunk)) this.onCommand(socket, frame);
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const t of state.meterTimers.values()) clearInterval(t);
      this.clients.delete(socket);
    });
  }

  private onCommand(socket: net.Socket, frame: string): void {
    const tokens = tokenize(frame.slice(1, -1));
    const [verb, a, b, c] = tokens;
    const deviceReply: Record<string, string> = {
      ...(this.answersModel ? { MODEL: this.braced(this.model) } : {}),
      ...(this.family === 'ulxd' ? { HIGH_DENSITY: 'OFF' } : {}),
      [this.family === 'psm1000' ? 'DEVICE_NAME' : 'DEVICE_ID']: this.braced(this.deviceId),
      FW_VER: '{0.0.0.0-sim}',
    };

    if (verb === 'GET' && a && a in deviceReply) {
      this.write(socket, `< REP ${a} ${deviceReply[a]} >`);
    } else if (verb === 'GET' && a && b === 'ALL') {
      const which = a === '0' ? this.channels.map((_, i) => i + 1) : [Number(a)];
      this.write(socket, which.flatMap((ch) => this.channelReports(ch)).join(''));
    } else if (verb === 'SET' && a && b === 'METER_RATE' && c) {
      const ch = Number(a);
      const ms = Number(c);
      const timers = this.clients.get(socket)!.meterTimers;
      clearInterval(timers.get(ch));
      timers.delete(ch);
      if (ms > 0) timers.set(ch, setInterval(() => this.write(socket, this.sample(ch)), Math.max(100, ms)));
      this.write(socket, `< REP ${ch} METER_RATE ${pad(ms, 5)} >`);
    } else if (verb === 'GET' && a && /^\d+$/.test(a) && b && b !== 'METER_RATE') {
      // Channel 0 means every channel.
      const which = a === '0' ? this.channels.map((_, i) => i + 1) : this.channels[Number(a) - 1] ? [Number(a)] : [];
      const replies = which.flatMap((ch) => this.channelReports(ch).filter((f) => f.startsWith(`< REP ${ch} ${b} `)));
      this.write(socket, replies.length ? replies.join('') : '< REP ERR >');
    } else if (verb === 'GET' && a && b === 'METER_RATE') {
      this.write(socket, `< REP ${a} METER_RATE 00000 >`);
    } else if (parseMessage(frame).kind === 'unknown') {
      this.write(socket, '< REP ERR >');
    }
  }

  private braced(s: string): string {
    const width = this.family === 'ulxd' ? 8 : 31;
    return `{${s.slice(0, width).padEnd(width, ' ')}}`;
  }

  private channelReports(n: number): string[] {
    const ch = this.channels[n - 1]!;
    const on = ch.txOn;
    const bars = on ? pad(ch.batteryBars, 3) : '255';
    const pct = on && ch.batteryPercent !== undefined ? pad(ch.batteryPercent, 3) : '255';
    const mins = on && ch.runtimeMin !== undefined ? pad(ch.runtimeMin, 5) : '65535';
    const rep = (key: string, value: string) => `< REP ${n} ${key} ${value} >`;

    switch (this.family) {
      case 'ulxd':
        return [
          rep('CHAN_NAME', this.braced(ch.name)),
          rep('FREQUENCY', pad(ch.frequencyKhz, 6)),
          rep('AUDIO_MUTE', ch.rxMuted ? 'ON' : 'OFF'),
          rep('BATT_BARS', bars),
          rep('BATT_CHARGE', pct),
          rep('BATT_RUN_TIME', mins),
          rep('TX_TYPE', on ? ch.txModel : 'UNKN'),
          rep('TX_DEVICE_ID', this.braced(on ? ch.txDeviceId : '')),
          rep('TX_OFFSET', on ? pad(ch.txOffsetDb, 3) : '255'),
        ];
      case 'axd':
        return [
          rep('CHAN_NAME', this.braced(ch.name)),
          rep('FREQUENCY', pad(ch.frequencyKhz, 7)),
          rep('AUDIO_MUTE', ch.rxMuted ? 'ON' : 'OFF'),
          rep('TX_BATT_BARS', bars),
          rep('TX_BATT_CHARGE_PERCENT', pct),
          rep('TX_BATT_MINS', mins),
          rep('TX_MODEL', on ? ch.txModel : 'UNKNOWN'),
          rep('TX_DEVICE_ID', this.braced(on ? ch.txDeviceId : '')),
          rep('TX_OFFSET', on ? pad(ch.txOffsetDb + 12, 3) : '255'),
          // As a real AD2 with a Shure rechargeable reports them (+40 on temperature).
          rep('TX_BATT_HEALTH_PERCENT', on && ch.batteryPercent !== undefined ? '089' : '255'),
          rep('TX_BATT_CYCLE_COUNT', on && ch.batteryPercent !== undefined ? '00301' : '65535'),
          rep('TX_BATT_TEMP_C', on && ch.batteryPercent !== undefined ? '063' : '255'),
          rep('ENCRYPTION_STATUS', 'OK'),
          rep('INTERFERENCE_STATUS', 'NONE'),
          rep('UNREGISTERED_TX_STATUS', 'OK'),
        ];
      case 'slxd':
        return [
          rep('CHAN_NAME', this.braced(ch.name)),
          rep('FREQUENCY', pad(ch.frequencyKhz, 7)),
          rep('TX_BATT_BARS', bars),
          rep('TX_BATT_MINS', mins),
          rep('TX_MODEL', on ? ch.txModel : 'UNKNOWN'),
        ];
      case 'psm1000':
        return [
          rep('CHAN_NAME', this.braced(ch.name)),
          rep('FREQUENCY', pad(ch.frequencyKhz, 6)),
          rep('GROUP_CHAN', '01,01'),
          rep('RF_TX_LVL', String(ch.rfOutputMw)),
          rep('RF_MUTE', ch.rfMuted ? '1' : '0'),
          rep('AUDIO_TX_MODE', String(ch.audioMode)),
        ];
    }
  }

  private sample(n: number): string {
    const ch = this.channels[n - 1];
    if (!ch) return '';
    const jitter = () => Math.round((Math.random() - 0.5) * 6);
    const on = ch.txOn;
    const rf = on ? ch.rfDbm + jitter() : -120;
    // Encode as real hardware would, so RF Ranger (which adds the audio trim) displays audioDbfs.
    // A slow syllable-like swell around the set level, so a level history looks like speech.
    const s = Date.now() / 1000 + n * 1.7;
    const swell = Math.round(Math.sin(s * 5.1) * Math.sin(s * 0.9) * 12);
    const audio = on ? Math.min(0, ch.audioDbfs + swell + jitter()) - AUDIO_TRIM_DB : -120;

    switch (this.family) {
      case 'ulxd':
        return `< SAMPLE ${n} ALL ${on ? 'AX' : 'XX'} ${pad(on ? rf + 128 : 0, 3)} ${pad(on ? audio + 50 : 0, 3)} >`;
      case 'axd': {
        const r = pad(rf + 120, 3);
        return `< SAMPLE ${n} ALL ${on ? '005' : '255'} 000 ${pad(audio + 126, 3)} ${pad(audio + 120, 3)} ${on ? 'BB' : 'XX'} 31 ${r} 31 ${r} >`;
      }
      case 'slxd':
        return `< SAMPLE ${n} ALL ${pad(audio + 126, 3)} ${pad(audio + 120, 3)} ${pad(rf + 120, 3)} >`;
      case 'psm1000':
        return ''; // layout not yet captured from hardware
    }
  }

  private write(socket: net.Socket, data: string): void {
    if (!data || socket.destroyed) return;
    if (!this.fragment || data.length < 4) {
      this.enqueue(socket, async () => { socket.write(data); });
      return;
    }
    // Split mid-message with a pause so the halves arrive as separate reads.
    const cut = 1 + Math.floor(Math.random() * (data.length - 2));
    this.enqueue(socket, async () => {
      socket.write(data.slice(0, cut));
      await new Promise((r) => setTimeout(r, 5));
      if (!socket.destroyed) socket.write(data.slice(cut));
    });
  }

  private queues = new WeakMap<net.Socket, Promise<void>>();

  /** Serialise writes per client so fragmented frames are never interleaved. */
  private enqueue(socket: net.Socket, job: () => Promise<void>): void {
    const prev = this.queues.get(socket) ?? Promise.resolve();
    this.queues.set(socket, prev.then(() => (socket.destroyed ? undefined : job())));
  }
}
