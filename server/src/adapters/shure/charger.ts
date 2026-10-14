/**
 * Shure networked docking chargers (SBC220 for AD1/AD2/ULXD1/ULXD2 on SB900
 * batteries, SBC240 for ADX on SB910/SB920). Up to four units can be ganged
 * behind one network connection, so bays are numbered across the gang.
 * Source: Shure "SBC220 SBC240 Command Strings" v2.0 (2020-K).
 */
import { EventEmitter } from 'node:events';
import { emptyBay, type BayTelemetry, type ChargerInfo, type ConnectionStatus } from '../../core/model.js';
import { absent, ok } from '../../core/reading.js';
import { ShureConnection } from './connection.js';
import { numeric } from './families.js';
import { getCommand, type ShureMessage } from './protocol.js';

export const BATT_ERRORS: Readonly<Record<string, string>> = {
  '001': 'Unknown module',
  '002': 'Unrecognized battery',
  '003': 'Deep discharge recovery failed',
  '004': 'Charge failed',
  '005': 'Check battery',
  '006': 'Check charger',
  '007': 'Communication failure',
};

type Apply = (b: BayTelemetry, args: string[], now: number) => void;

export const BAY_REPORTS: Readonly<Record<string, Apply>> = {
  BATT_DETECTED: (b, [v], now) => {
    b.batteryPresent = v === 'YES' ? ok(true, now) : v === 'NO' ? ok(false, now) : absent(now);
  },
  BATT_CHARGE: (b, [v], now) => { b.chargePercent = numeric(v, now); },
  BATT_BARS: (b, [v], now) => { b.batteryBars = numeric(v, now); },
  BATT_HEALTH: (b, [v], now) => { b.healthPercent = numeric(v, now); },
  BATT_STATE: (b, [v], now) => {
    if (v === 'FULL') b.full = ok(true, now);
    else if (v === 'NORMAL') b.full = ok(false, now);
  },
  // 0-65528 minutes, 65529 full, 65533 calculating, 65534 error, 65535 no battery
  BATT_TIME_TO_FULL: (b, [v], now) => {
    if (v === '65529') {
      b.minutesToFull = ok(0, now);
      b.full = ok(true, now);
      return;
    }
    const n = v !== undefined && /^\d{5}$/.test(v) ? Number(v) : NaN;
    b.minutesToFull = n <= 65528 ? ok(n, now) : absent(now);
    if (n <= 65528) b.full = ok(false, now);
  },
  BATT_ERROR: (b, [v], now) => {
    if (v === '000') b.error = ok(null, now);
    else if (v === '255' || v === undefined) b.error = absent(now);
    else b.error = ok(BATT_ERRORS[v] ?? `Error ${v}`, now);
  },
};

export interface ShureChargerOptions {
  id: string;
  host: string;
  port?: number;
  silenceTimeoutMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
}

interface Events {
  status: [ConnectionStatus];
  bay: [bay: number, telemetry: BayTelemetry];
  info: [ChargerInfo];
  wire: [direction: 'in' | 'out', frame: string];
}

export class ShureCharger extends EventEmitter<Events> {
  readonly info: ChargerInfo;
  /** Bays appear as the charger reports them, so ganged units need no config. */
  readonly bays = new Map<number, BayTelemetry>();
  private readonly conn: ShureConnection;

  constructor(opts: ShureChargerOptions) {
    super();
    this.info = { id: opts.id, manufacturer: 'shure', host: opts.host };
    this.conn = new ShureConnection({
      host: opts.host,
      port: opts.port,
      silenceTimeoutMs: opts.silenceTimeoutMs,
      connectTimeoutMs: opts.connectTimeoutMs,
      now: opts.now,
      // Chargers only report on change; poll so silence still means a dead link.
      heartbeat: getCommand(undefined, 'DEVICE_ID'),
      onConnect: () => [
        getCommand(undefined, 'MODEL'),
        getCommand(undefined, 'DEVICE_ID'),
        getCommand(undefined, 'FW_VER'),
        getCommand(undefined, 'STORAGE_MODE'),
        getCommand(0, 'ALL'),
      ],
    });
    this.conn.on('status', (s) => this.emit('status', s));
    this.conn.on('wire', (dir, frame) => this.emit('wire', dir, frame));
    this.conn.on('message', (msg, now) => this.handle(msg, now));
  }

  get status(): ConnectionStatus {
    return this.conn.status;
  }

  start(): void {
    this.conn.start();
  }

  stop(): Promise<void> {
    return this.conn.stop();
  }

  send(frame: string): void {
    this.conn.send(frame);
  }

  private handle(msg: ShureMessage, now: number): void {
    if (msg.kind !== 'rep') return;

    if (msg.channel === undefined) {
      const value = msg.args.join(' ');
      const before = JSON.stringify(this.info);
      if (msg.key === 'MODEL') this.info.model = value;
      else if (msg.key === 'DEVICE_ID') this.info.deviceId = value;
      else if (msg.key === 'FW_VER') this.info.firmware = value;
      else if (msg.key === 'STORAGE_MODE') this.info.storageMode = value === 'ON';
      if (JSON.stringify(this.info) !== before) this.emit('info', this.info);
      return;
    }

    const apply = BAY_REPORTS[msg.key];
    if (!apply || msg.channel < 1) return;
    let bay = this.bays.get(msg.channel);
    if (!bay) {
      bay = emptyBay();
      this.bays.set(msg.channel, bay);
    }
    apply(bay, msg.args, now);
    // A bay that reports "no battery" has no meaningful charge values.
    if (bay.batteryPresent.state === 'ok' && !bay.batteryPresent.value) {
      bay.chargePercent = absent(now);
      bay.minutesToFull = absent(now);
      bay.full = absent(now);
    }
    this.emit('bay', msg.channel, bay);
  }
}
