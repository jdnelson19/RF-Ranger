import net from 'node:net';
import { ShureFramer, tokenize } from '../adapters/shure/protocol.js';

/** A fake SBC220/SBC240 for tests and demo mode. */
export interface SimBay {
  present: boolean;
  chargePercent: number;
  error?: string; // 3-digit BATT_ERROR code
}

export class ChargerSim {
  readonly bays: SimBay[];
  private server = net.createServer((s) => this.onClient(s));
  private clients = new Set<net.Socket>();
  private ticker: NodeJS.Timeout | undefined;

  constructor(bays: Partial<SimBay>[], readonly model = 'SBC220') {
    this.bays = bays.map((b) => ({ present: true, chargePercent: 100, ...b }));
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    await new Promise<void>((r) => this.server.listen(port, host, r));
    // Charge docked batteries by 1% every few seconds, like a (fast) charger.
    this.ticker = setInterval(() => {
      this.bays.forEach((b, i) => {
        if (b.present && b.chargePercent < 100) this.update(i + 1, { chargePercent: b.chargePercent + 1 });
      });
    }, 3_000);
    return (this.server.address() as net.AddressInfo).port;
  }

  async close(): Promise<void> {
    clearInterval(this.ticker);
    for (const s of this.clients) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  update(bay: number, patch: Partial<SimBay>): void {
    Object.assign(this.bays[bay - 1]!, patch);
    for (const s of this.clients) s.write(this.bayReports(bay));
  }

  private onClient(s: net.Socket): void {
    this.clients.add(s);
    const framer = new ShureFramer();
    s.setEncoding('ascii');
    s.on('error', () => {});
    s.on('close', () => this.clients.delete(s));
    s.on('data', (chunk: string) => {
      for (const frame of framer.push(chunk)) {
        const [verb, a, b] = tokenize(frame.slice(1, -1));
        if (verb !== 'GET') continue;
        if (a === 'MODEL') s.write(`< REP MODEL {${this.model.padEnd(31)}} >`);
        else if (a === 'DEVICE_ID') s.write(`< REP DEVICE_ID {${'Sim Charger'.padEnd(31)}} >`);
        else if (a === 'FW_VER') s.write(`< REP FW_VER {${'0.0.0.0-sim'.padEnd(24)}} >`);
        else if (a === 'STORAGE_MODE') s.write('< REP STORAGE_MODE OFF >');
        else if (a === '0' && b === 'ALL') s.write(this.bays.map((_, i) => this.bayReports(i + 1)).join(''));
      }
    });
  }

  private bayReports(n: number): string {
    const b = this.bays[n - 1]!;
    const pad = (v: number, w: number) => String(v).padStart(w, '0');
    if (!b.present) {
      return [`< REP ${n} BATT_DETECTED NO >`, `< REP ${n} BATT_TIME_TO_FULL 65535 >`, `< REP ${n} BATT_ERROR 255 >`].join('');
    }
    const full = b.chargePercent >= 100;
    return [
      `< REP ${n} BATT_DETECTED YES >`,
      `< REP ${n} BATT_CHARGE ${pad(b.chargePercent, 3)} >`,
      `< REP ${n} BATT_BARS ${pad(Math.ceil(b.chargePercent / 20), 3)} >`,
      `< REP ${n} BATT_HEALTH 097 >`,
      `< REP ${n} BATT_TIME_TO_FULL ${full ? '65529' : pad((100 - b.chargePercent) * 2, 5)} >`,
      `< REP ${n} BATT_STATE ${full ? 'FULL' : 'NORMAL'} >`,
      `< REP ${n} BATT_ERROR ${b.error ?? '000'} >`,
    ].join('');
  }
}
