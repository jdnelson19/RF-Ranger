import type http from 'node:http';
import { defaultPort, isSennheiser, type DeviceFamilyId } from '../adapters/families.js';
import { SscConnection } from '../adapters/sennheiser/connection.js';
import { identifySennheiser } from '../adapters/sennheiser/identify.js';
import { SSC_PORT, merge, tree, type SscValue } from '../adapters/sennheiser/ssc.js';
import { SHURE_PORT, SHURE_PORTS, ShureConnection } from '../adapters/shure/connection.js';
import { identifyShure, identifyShureOnPorts, type Identity } from '../adapters/shure/identify.js';
import { getCommand, meterRateCommand, parseMessage } from '../adapters/shure/protocol.js';
import { VERSION } from '../version.js';
import { SscCrawl, isPrivateAddress, knownAddresses, meterSubscriptions, normalizeSscRead, redactSsc, sscKeys } from './inspector-ssc.js';
import type { Runtime } from './runtime.js';

/**
 * Device Inspector: watch the raw protocol traffic of any device, send
 * read-only queries, tag what it is, and export a report that helps add
 * support for models the project doesn't have.
 *
 * Safety: only GET commands can be sent. The single exception is a timed
 * metering burst (SET METER_RATE), which is always switched back off.
 * Sennheiser devices (SSC, port 45) are handled alike: reads only, plus a
 * crawl of the address tree and a timed meter subscription (inspector-ssc.ts).
 */

export { VERSION };

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

export type InspectorProtocol = 'shure' | 'ssc';

/** What the device says it is: Shure identify, or the SSC identity mapped onto the same fields. */
type InspectorIdentity = Omit<Identity, 'kind'> & { kind?: string; firmware?: string };

interface Session {
  id: string;
  host: string;
  port: number;
  protocol: InspectorProtocol;
  openedAt: number;
  monitoredBy?: string;
  status: () => string;
  send: (frame: string) => void;
  /** Shure: end commands in "\r\n" from now on (a PSM 1000 needs it). */
  useLineEnding?: () => void;
  stop: () => Promise<void>;
  frames: InspectorFrame[];
  seq: number;
  keys: Map<string, KeyStat>;
  identity?: InspectorIdentity;
  tags: InspectorTags;
  metering?: { channels: number[]; timer: NodeJS.Timeout; until: number };
  crawl?: SscCrawl;
}

const MAX_FRAMES = 5_000;
const MAX_METER_SECONDS = 120;

export class Inspector {
  private sessions = new Map<string, Session>();

  constructor(private readonly runtime: Runtime) {}

  open(host: string, port = SHURE_PORT, protocol: InspectorProtocol = port === SSC_PORT ? 'ssc' : 'shure'): Session {
    if (!/^[\w.-]+$/.test(host)) throw new Error('Enter an IP address or host name');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const id = `${host}:${port}`;
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const session: Session = {
      id, host, port, protocol, openedAt: Date.now(), frames: [], seq: 0, keys: new Map(), tags: {},
      status: () => 'disconnected', send: () => {}, stop: async () => {},
    };
    const record = (dir: 'in' | 'out', frame: string) => this.record(session, dir, frame);

    // Reuse the live connection if RF Ranger already monitors this device.
    const device = [...this.runtime.receivers.values(), ...this.runtime.chargers.values()].find((d) => {
      const cfg = [...this.runtime.config.receivers, ...this.runtime.config.chargers].find((c) => c.id === d.info.id);
      const familyPort = 'family' in d && d.family ? defaultPort(d.family.id as DeviceFamilyId) : SHURE_PORT;
      return d.info.host === host && (cfg?.port ?? familyPort) === port;
    });

    if (device) {
      session.monitoredBy = device.info.id;
      session.protocol = device.info.manufacturer === 'sennheiser' ? 'ssc' : 'shure';
      device.on('wire', record);
      session.status = () => device.status.state;
      session.send = (f) => device.send?.(f);
      session.stop = async () => { device.off('wire', record); };
      session.identity = {
        host, reachable: true, model: device.info.model, deviceId: device.info.deviceId, firmware: device.info.firmware,
        kind: 'family' in device ? device.family.id : undefined, channels: 'channelCount' in device.info ? device.info.channelCount : undefined,
      };
      this.note(session, `Watching ${device.info.id}'s existing connection (already monitored by RF Ranger).`);
    } else if (protocol === 'ssc') {
      const conn = new SscConnection({
        host,
        port,
        silenceTimeoutMs: 15_000,
        onConnect: () => [merge(tree(['device', 'name']), tree(['device', 'identity', 'product']), tree(['device', 'identity', 'version'])), { osc: { version: null } }],
        // Nothing to keep alive but the link itself: pings do that.
        renew: () => [],
        onClose: () => (session.metering ? meterSubscriptions(this.sscFamily(session), session.metering.channels, 0, true) : []),
      });
      conn.on('wire', record);
      conn.on('status', (st) => this.note(session, `Connection ${st.state}${st.lastError && st.state !== 'connected' ? `: ${st.lastError}` : ''}`));
      session.status = () => conn.status.state;
      session.send = (f) => conn.send(JSON.parse(f) as Record<string, SscValue>);
      session.stop = () => conn.stop();
      conn.start();
      void identifySennheiser(host, port).then((idn) => {
        session.identity = { host, port, reachable: idn.reachable, model: idn.product, deviceId: idn.deviceName, firmware: idn.version, kind: idn.family, channels: idn.channels, unsupported: idn.unsupported };
        this.note(session, idn.reachable
          ? `Identified: ${idn.product ?? 'unknown product'}${idn.family ? ` (${idn.family})` : ''}${idn.unsupported ? `: ${idn.unsupported}` : ''}`
          : 'No answer on SSC port 45. On EW-DX, turn on 3rd party access ("Legacy", SSCv1) in Control Cockpit first.');
      });
    } else {
      const conn = new ShureConnection({
        host,
        port,
        heartbeat: getCommand(undefined, 'DEVICE_ID'),
        heartbeatMs: 5_000,
        silenceTimeoutMs: 15_000,
        // DEVICE_NAME: the PSM 1000's name for what receivers call DEVICE_ID.
        onConnect: () => [getCommand(undefined, 'MODEL'), getCommand(undefined, 'DEVICE_ID'), getCommand(undefined, 'DEVICE_NAME'), getCommand(undefined, 'FW_VER')],
        onClose: () => (session.metering ? session.metering.channels.map((ch) => meterRateCommand(ch, 0)) : []),
      });
      conn.on('wire', record);
      conn.on('status', (s) => this.note(session, `Connection ${s.state}${s.lastError && s.state !== 'connected' ? `: ${s.lastError}` : ''}`));
      session.status = () => conn.status.state;
      session.send = (f) => conn.send(f);
      session.useLineEnding = () => {
        if (conn.lineEnding) return;
        conn.lineEnding = '\r\n';
        this.note(session, 'This looks like a PSM 1000: commands are now sent ending in a line break, which it needs. Press Get all or send your query again.');
      };
      session.stop = () => conn.stop();
      conn.start();
      void identifyShure(host, port).then((idn) => {
        session.identity = idn;
        if (idn.kind === 'psm1000') session.useLineEnding?.();
        this.note(session, idn.reachable ? `Identified: ${idn.model ?? 'unknown model'}${idn.kind ? ` (${idn.kind})` : ''}${idn.unsupported ? `: ${idn.unsupported}` : ''}` : 'No answer on the control port.');
      });
    }

    this.sessions.set(id, session);
    return session;
  }

  async close(id: string): Promise<void> {
    const s = this.get(id);
    s.crawl?.stop();
    this.stopMetering(s);
    await s.stop();
    this.sessions.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** Send a read-only query. Shure: "GET 1 ALL" or "< GET 1 ALL >". SSC: "/rx1/name /mm" or JSON with null values. */
  send(id: string, command: string): string {
    const s = this.get(id);
    const frame = s.protocol === 'ssc' ? JSON.stringify(normalizeSscRead(command)) : normalizeGet(command);
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
    if (s.protocol === 'ssc') for (const m of meterSubscriptions(this.sscFamily(s), channels, secs)) s.send(JSON.stringify(m));
    else for (const ch of channels) s.send(meterRateCommand(ch, 1_000));
    s.metering = { channels, until: Date.now() + secs * 1000, timer: setTimeout(() => this.stopMetering(s), secs * 1000) };
    this.note(s, `Metering on for ${secs} s (1 sample per second on channels ${channels.join(', ')}). It switches off automatically.`);
  }

  /** SSC: list every address the device has and read each one, for a complete device report. */
  readEverything(id: string): void {
    const s = this.get(id);
    if (s.protocol !== 'ssc') throw new Error('Read everything is for Sennheiser (SSC) devices; on Shure devices use Get all.');
    if (s.crawl && !s.crawl.done) throw new Error('Already reading.');
    s.crawl = new SscCrawl((m) => s.send(JSON.stringify(m)), (t) => this.note(s, t), () => knownAddresses(this.sscFamily(s)));
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
      id: s.id, host: s.host, port: s.port, protocol: s.protocol, status: s.status(), monitoredBy: s.monitoredBy, model: s.identity?.model ?? s.tags.model,
    }));
  }

  view(id: string, after = 0) {
    const s = this.get(id);
    const frames = s.frames.filter((f) => f.seq > after);
    return {
      id: s.id,
      host: s.host,
      port: s.port,
      protocol: s.protocol,
      status: s.status(),
      monitoredBy: s.monitoredBy,
      identity: s.identity,
      reading: !!s.crawl && !s.crawl.done,
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
    const ssc = s.protocol === 'ssc';
    const scrub = (text: string) => (!anonymize ? text : ssc ? redactSsc(text, s.host) : redact(text, s.host));
    const privateKey = (key: string) => (ssc ? isPrivateAddress(key) : NAME_KEYS.has(key));
    return {
      kind: 'rf-ranger-device-report',
      reportVersion: 1,
      protocol: s.protocol,
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
      keysSeen: [...s.keys.values()].map((k) => ({ ...k, value: anonymize && privateKey(k.key) ? 'redacted' : scrub(k.value) })),
      frames: s.frames.map((f) => ({ ...f, frame: scrub(f.frame) })),
    };
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error('No such inspector session');
    return s;
  }

  private sscFamily(s: Session) {
    const kind = s.identity?.kind;
    return kind && isSennheiser(kind as DeviceFamilyId) ? (kind as 'ewdx' | 'd6000') : undefined;
  }

  private stopMetering(s: Session): void {
    if (!s.metering) return;
    clearTimeout(s.metering.timer);
    if (s.protocol === 'ssc') for (const m of meterSubscriptions(this.sscFamily(s), s.metering.channels, 0, true)) s.send(JSON.stringify(m));
    else for (const ch of s.metering.channels) s.send(meterRateCommand(ch, 0));
    s.metering = undefined;
    this.note(s, 'Metering off.');
  }

  private note(s: Session, text: string): void {
    this.push(s, 'note', text);
  }

  private record(s: Session, dir: 'in' | 'out', frame: string): void {
    this.push(s, dir, frame);
    if (dir !== 'in') return;
    const now = Date.now();
    const bump = (key: string, channel: number | undefined, value: string) => {
      const k = `${channel ?? '-'}:${key}`;
      const stat = s.keys.get(k);
      if (stat) Object.assign(stat, { value, count: stat.count + 1, lastSeen: now });
      else s.keys.set(k, { key, channel, value, count: 1, lastSeen: now });
    };
    if (s.protocol === 'ssc') {
      let msg: Record<string, SscValue>;
      try {
        msg = JSON.parse(frame) as Record<string, SscValue>;
      } catch {
        return;
      }
      for (const k of sscKeys(msg)) bump(k.key, k.channel, k.value);
      s.crawl?.onMessage(msg);
      return;
    }
    const m = parseMessage(frame);
    // REPORT (not REP) and AUDIO_IN_LVL come only from the PSM 1000.
    if (/^<\s*REPORT\b/.test(frame) || (m.kind === 'rep' && m.key.startsWith('AUDIO_IN_LVL'))) s.useLineEnding?.();
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

export async function handleInspector(inspector: Inspector, req: http.IncomingMessage, res: http.ServerResponse, url: URL, allows: (req: http.IncomingMessage) => boolean = isLocalRequest): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!allows(req)) {
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
        const host = String(body.host ?? '').trim();
        // No port given: use whichever answers of 2202 / 2201 (Shure, PSM 1000) and 45 (Sennheiser SSC).
        const port = body.port === undefined || body.port === '' ? await findPort(host) : Number(body.port);
        const s = inspector.open(host, port);
        return json(200, { id: s.id });
      }
      if (route === 'close') { await inspector.close(id); return json(200, {}); }
      if (route === 'send') return json(200, { sent: inspector.send(id, String(body.command ?? '')) });
      if (route === 'read-everything') { inspector.readEverything(id); return json(200, {}); }
      if (route === 'meter') { inspector.meter(id, Number(body.seconds ?? 30)); return json(200, {}); }
      if (route === 'tags') { inspector.setTags(id, body.tags as InspectorTags); return json(200, {}); }
    }
    json(404, { error: 'Unknown inspector request' });
  } catch (err) {
    json(400, { error: (err as Error).message });
  }
}

async function findPort(host: string): Promise<number> {
  if (!/^[\w.-]+$/.test(host)) return SHURE_PORT;
  const [shure, ssc] = await Promise.all([identifyShureOnPorts(host, SHURE_PORTS, 1_500), identifySennheiser(host, SSC_PORT, 1_500)]);
  if (shure.reachable && shure.port) return shure.port;
  return ssc.reachable ? SSC_PORT : SHURE_PORT;
}

export function readJson(req: http.IncomingMessage): Promise<unknown> {
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
