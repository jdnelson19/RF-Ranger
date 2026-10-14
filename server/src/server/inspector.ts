import { readFileSync } from 'node:fs';
import type http from 'node:http';
import { ShureConnection } from '../adapters/shure/connection.js';
import { identifyShure, type Identity } from '../adapters/shure/identify.js';
import { getCommand, meterRateCommand, parseMessage } from '../adapters/shure/protocol.js';
import type { Runtime } from './runtime.js';

/**
 * Device Inspector: watch the raw protocol traffic of any device, send
 * read-only queries, tag what it is, and export a report that helps add
 * support for models the project doesn't have.
 *
 * Safety: only GET commands can be sent. The single exception is a timed
 * metering burst (SET METER_RATE), which is always switched back off.
 */

export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

export interface InspectorFrame {
  seq: number;
  t: number;
  dir: 'in' | 'out' | 'note';
  frame: string;
}

export interface KeyStat {
  key: string;
  channel?: number;
  value: string;
  count: number;
  lastSeen: number;
}

export interface InspectorTags {
  kind?: string;
  model?: string;
  firmware?: string;
  notes?: string;
}

interface Session {
  id: string;
  host: string;
  port: number;
  openedAt: number;
  monitoredBy?: string;
  status: () => string;
  send: (frame: string) => void;
  stop: () => Promise<void>;
  frames: InspectorFrame[];
  seq: number;
  keys: Map<string, KeyStat>;
  identity?: Identity;
  tags: InspectorTags;
  metering?: { channels: number[]; timer: NodeJS.Timeout; until: number };
}

const MAX_FRAMES = 5_000;
const MAX_METER_SECONDS = 120;

export class Inspector {
  private sessions = new Map<string, Session>();

  constructor(private readonly runtime: Runtime) {}

  open(host: string, port = 2202): Session {
    if (!/^[\w.-]+$/.test(host)) throw new Error('Enter an IP address or host name');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const id = `${host}:${port}`;
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const session: Session = {
      id, host, port, openedAt: Date.now(), frames: [], seq: 0, keys: new Map(), tags: {},
      status: () => 'disconnected', send: () => {}, stop: async () => {},
    };
    const record = (dir: 'in' | 'out', frame: string) => this.record(session, dir, frame);

    // Reuse the live connection if RF Ranger already monitors this device.
    const device = [...this.runtime.receivers.values(), ...this.runtime.chargers.values()].find((d) => {
      const cfg = [...this.runtime.config.receivers, ...this.runtime.config.chargers].find((c) => c.id === d.info.id);
      return d.info.host === host && (cfg?.port ?? 2202) === port;
    });

    if (device) {
      session.monitoredBy = device.info.id;
      device.on('wire', record);
      session.status = () => device.status.state;
      session.send = (f) => device.send(f);
      session.stop = async () => { device.off('wire', record); };
      session.identity = { host, reachable: true, model: device.info.model, deviceId: device.info.deviceId };
      this.note(session, `Watching ${device.info.id}'s existing connection (already monitored by RF Ranger).`);
    } else {
      const conn = new ShureConnection({
        host,
        port,
        heartbeat: getCommand(undefined, 'DEVICE_ID'),
        heartbeatMs: 5_000,
        silenceTimeoutMs: 15_000,
        onConnect: () => [getCommand(undefined, 'MODEL'), getCommand(undefined, 'DEVICE_ID'), getCommand(undefined, 'FW_VER')],
        onClose: () => (session.metering ? session.metering.channels.map((ch) => meterRateCommand(ch, 0)) : []),
      });
      conn.on('wire', record);
      conn.on('status', (s) => this.note(session, `Connection ${s.state}${s.lastError && s.state !== 'connected' ? `: ${s.lastError}` : ''}`));
      session.status = () => conn.status.state;
      session.send = (f) => conn.send(f);
      session.stop = () => conn.stop();
      conn.start();
      void identifyShure(host, port).then((idn) => {
        session.identity = idn;
        this.note(session, idn.reachable ? `Identified: ${idn.model ?? 'unknown model'}${idn.kind ? ` (${idn.kind})` : ''}${idn.unsupported ? `: ${idn.unsupported}` : ''}` : 'No answer on the control port.');
      });
    }

    this.sessions.set(id, session);
    return session;
  }

  async close(id: string): Promise<void> {
    const s = this.get(id);
    this.stopMetering(s);
    await s.stop();
    this.sessions.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** Send a read-only query. Accepts "GET 1 ALL" or "< GET 1 ALL >". */
  send(id: string, command: string): string {
    const s = this.get(id);
    const frame = normalizeGet(command);
    s.send(frame);
    return frame;
  }

  /** Turn metering on for a limited time so SAMPLE formats can be captured. */
  meter(id: string, seconds: number): void {
    const s = this.get(id);
    if (s.monitoredBy) throw new Error('This device is already metered by RF Ranger; its samples are in the log.');
    const secs = Math.max(5, Math.min(MAX_METER_SECONDS, Math.round(seconds)));
    const known = s.identity?.channels;
    const channels = Array.from({ length: known ?? 4 }, (_, i) => i + 1);
    this.stopMetering(s);
    for (const ch of channels) s.send(meterRateCommand(ch, 1_000));
    s.metering = { channels, until: Date.now() + secs * 1000, timer: setTimeout(() => this.stopMetering(s), secs * 1000) };
    this.note(s, `Metering on for ${secs} s (1 sample per second on channels ${channels.join(', ')}). It switches off automatically.`);
  }

  setTags(id: string, tags: InspectorTags): void {
    const s = this.get(id);
    s.tags = {
      kind: clean(tags.kind, 40),
      model: clean(tags.model, 60),
      firmware: clean(tags.firmware, 60),
      notes: clean(tags.notes, 4_000),
    };
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, host: s.host, port: s.port, status: s.status(), monitoredBy: s.monitoredBy, model: s.identity?.model ?? s.tags.model,
    }));
  }

  view(id: string, after = 0) {
    const s = this.get(id);
    const frames = s.frames.filter((f) => f.seq > after);
    return {
      id: s.id,
      host: s.host,
      port: s.port,
      status: s.status(),
      monitoredBy: s.monitoredBy,
      identity: s.identity,
      tags: s.tags,
      meteringUntil: s.metering?.until,
      lastSeq: s.seq,
      frames: frames.slice(-1_000),
      keys: [...s.keys.values()].sort((a, b) => (a.channel ?? 0) - (b.channel ?? 0) || a.key.localeCompare(b.key)),
    };
  }

  /** Everything needed to add or fix support for this device. */
  report(id: string, anonymize: boolean) {
    const s = this.get(id);
    const scrub = (text: string) => (anonymize ? redact(text, s.host) : text);
    return {
      kind: 'rf-ranger-device-report',
      reportVersion: 1,
      rfRangerVersion: VERSION,
      createdAt: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}, Node ${process.version}`,
      anonymized: anonymize,
      device: {
        host: anonymize ? 'redacted' : s.host,
        port: s.port,
        monitoredByRfRanger: !!s.monitoredBy,
        identified: s.identity && {
          ...s.identity,
          host: anonymize ? 'redacted' : s.identity.host,
          deviceId: anonymize && s.identity.deviceId ? 'redacted' : s.identity.deviceId,
        },
        userTags: s.tags,
      },
      keysSeen: [...s.keys.values()].map((k) => ({ ...k, value: anonymize && NAME_KEYS.has(k.key) ? 'redacted' : scrub(k.value) })),
      frames: s.frames.map((f) => ({ ...f, frame: scrub(f.frame) })),
    };
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error('No such inspector session');
    return s;
  }

  private stopMetering(s: Session): void {
    if (!s.metering) return;
    clearTimeout(s.metering.timer);
    for (const ch of s.metering.channels) s.send(meterRateCommand(ch, 0));
    s.metering = undefined;
    this.note(s, 'Metering off.');
  }

  private note(s: Session, text: string): void {
    this.push(s, 'note', text);
  }

  private record(s: Session, dir: 'in' | 'out', frame: string): void {
    this.push(s, dir, frame);
    if (dir !== 'in') return;
    const m = parseMessage(frame);
    const now = Date.now();
    const bump = (key: string, channel: number | undefined, value: string) => {
      const k = `${channel ?? '-'}:${key}`;
      const stat = s.keys.get(k);
      if (stat) Object.assign(stat, { value, count: stat.count + 1, lastSeen: now });
      else s.keys.set(k, { key, channel, value, count: 1, lastSeen: now });
    };
    if (m.kind === 'rep') bump(m.key, m.channel, m.args.join(' '));
    else if (m.kind === 'sample') bump('SAMPLE ALL', m.channel, m.args.join(' '));
  }

  private push(s: Session, dir: InspectorFrame['dir'], frame: string): void {
    s.frames.push({ seq: ++s.seq, t: Date.now(), dir, frame });
    if (s.frames.length > MAX_FRAMES) s.frames.splice(0, s.frames.length - MAX_FRAMES);
  }
}

export function normalizeGet(command: string): string {
  let c = command.trim();
  if (c.startsWith('<')) c = c.slice(1);
  if (c.endsWith('>')) c = c.slice(0, -1);
  c = c.trim().replace(/\s+/g, ' ');
  if (!/^GET\s/i.test(c)) throw new Error('Only GET commands can be sent from the inspector, so it can never change device settings.');
  if (/[<>{}\r\n]/.test(c)) throw new Error('Commands cannot contain < > { } or line breaks.');
  if (c.length > 120) throw new Error('Command too long.');
  return `< ${c.replace(/^get/i, 'GET').toUpperCase()} >`;
}

const NAME_KEYS = new Set(['CHAN_NAME', 'DEVICE_ID', 'TX_DEVICE_ID', 'SLOT_TX_DEVICE_ID']);

/** Remove names and identifiers people may not want to share. */
export function redact(text: string, host?: string): string {
  let out = text.replace(/((?:CHAN_NAME|DEVICE_ID|TX_DEVICE_ID|SLOT_TX_DEVICE_ID)(?: \d+)? )\{[^}]*\}/g, '$1{redacted}');
  out = out.replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, 'x.x.x.x');
  if (host) out = out.split(host).join('redacted-host');
  return out;
}

function clean(v: string | undefined, max: number): string | undefined {
  const t = v?.trim();
  return t ? t.slice(0, max) : undefined;
}

// ---- HTTP -------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The inspector can open connections and send queries, so it only answers
 * the computer running RF Ranger: loopback peer, a localhost Host header
 * (guards against DNS rebinding), a localhost Origin when present, and JSON
 * bodies (forces a CORS preflight that other sites can't pass).
 */
export function isLocalRequest(req: http.IncomingMessage): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTNAMES.has(hostHeader)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL_HOSTNAMES.has(new URL(origin).hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function handleInspector(inspector: Inspector, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!isLocalRequest(req)) {
    json(403, { error: 'The Device Inspector is only available on the computer running RF Ranger.' });
    return;
  }

  try {
    const route = url.pathname.replace(/^\/api\/inspector\/?/, '');
    if (req.method === 'GET') {
      if (route === '') return json(200, { allowed: true, version: VERSION, sessions: inspector.list() });
      if (route === 'view') return json(200, inspector.view(url.searchParams.get('id') ?? '', Number(url.searchParams.get('after') ?? 0)));
      if (route === 'report') {
        const id = url.searchParams.get('id') ?? '';
        const anonymize = url.searchParams.get('anonymize') !== '0';
        const report = inspector.report(id, anonymize);
        const name = `rf-ranger-device-report-${(report.device.identified?.model ?? 'device').replace(/[^\w-]+/g, '_')}-${Date.now()}.json`;
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}"` });
        res.end(JSON.stringify(report, null, 2));
        return;
      }
    } else if (req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'Expected JSON' });
      const body = (await readJson(req)) as Record<string, unknown>;
      const id = String(body.id ?? '');
      if (route === 'open') {
        const s = inspector.open(String(body.host ?? '').trim(), body.port === undefined || body.port === '' ? 2202 : Number(body.port));
        return json(200, { id: s.id });
      }
      if (route === 'close') { await inspector.close(id); return json(200, {}); }
      if (route === 'send') return json(200, { sent: inspector.send(id, String(body.command ?? '')) });
      if (route === 'meter') { inspector.meter(id, Number(body.seconds ?? 30)); return json(200, {}); }
      if (route === 'tags') { inspector.setTags(id, body.tags as InspectorTags); return json(200, {}); }
    }
    json(404, { error: 'Unknown inspector request' });
  } catch (err) {
    json(400, { error: (err as Error).message });
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      data += c;
      if (data.length > 64_000) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
