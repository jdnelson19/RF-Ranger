/**
 * The Device Inspector's Sennheiser (SSC) side: read-only queries, a crawl
 * of the device's whole address tree for device reports, timed metering,
 * and redaction. Shure devices are handled in inspector.ts.
 *
 * Safety: every value sent is null, which SSC defines as a read. The only
 * other messages are schema queries (what addresses exist) and a metering
 * subscription with a short lifetime that is cancelled when it ends.
 */
import { SENNHEISER_FAMILIES, type SennheiserFamilyId } from '../adapters/sennheiser/families.js';
import { errors, leaves, merge, subscribe, tree, type SscValue } from '../adapters/sennheiser/ssc.js';

const isObject = (v: SscValue | undefined): v is { [key: string]: SscValue } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A read-only SSC request from what someone typed: JSON whose values are all
 * null ({"rx1":{"name":null}}), or addresses separated by spaces
 * ("/rx1/name /mm"). Schema and limits queries are allowed too.
 */
export function normalizeSscRead(command: string): Record<string, SscValue> {
  const c = command.trim();
  if (c.length > 2_000) throw new Error('Request too long.');
  let msg: Record<string, SscValue>;
  if (c.startsWith('{')) {
    try {
      msg = JSON.parse(c) as Record<string, SscValue>;
    } catch {
      throw new Error('Not valid JSON.');
    }
    if (!isObject(msg)) throw new Error('Expected a JSON object.');
  } else {
    const paths = c.split(/\s+/).filter(Boolean);
    if (!paths.length || !paths.every((p) => /^\/[\w/-]+$/.test(p))) throw new Error('Enter addresses like /rx1/name, or JSON like {"rx1":{"name":null}}.');
    msg = merge(...paths.map((p) => tree(p.slice(1).split('/').filter(Boolean))));
  }
  if (!readOnly(msg)) {
    throw new Error('Only reads can be sent from the inspector (every value null), so it can never change device settings.');
  }
  return msg;
}

/** Every value is null; under /osc only schema, limits, version and feature queries. */
function readOnly(msg: Record<string, SscValue>): boolean {
  const allNull = (v: SscValue): boolean => (v === null ? true : isObject(v) ? Object.values(v).every(allNull) : false);
  for (const [k, v] of Object.entries(msg)) {
    if (k !== 'osc') {
      if (!allNull(v)) return false;
      continue;
    }
    if (!isObject(v)) return false;
    for (const [ok, ov] of Object.entries(v)) {
      if (ok === 'schema' || ok === 'limits') {
        if (!(ov === null || (Array.isArray(ov) && ov.every((x) => isObject(x) && allNull(x))))) return false;
      } else if (ok === 'version' || ok === 'feature' || ok === 'ping') {
        if (!allNull(ov)) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

/** Addresses the crawl never reads: actions, secrets, and the protocol's own branch. */
const SKIP = /(^|\/)(osc|reset|restore|reboot|factory|update|identify|identification|password|passwd|key|keys|secret|certificate)(\/|$)/i;

const MAX_CONTAINERS = 500;
const MAX_METHODS = 3_000;
const READS_PER_MESSAGE = 4;
const QUIET_MS = 1_500;

/**
 * Walks /osc/schema from the root to list every address, then reads them
 * all, a few per message, one message per tick. Replies arrive through
 * onMessage (the session's normal receive path), so nothing waits on a
 * particular answer: a lost datagram just means one branch fewer.
 */
export class SscCrawl {
  private queue: string[][] = [[]];
  private containers = new Set<string>(['']);
  private methods: string[][] = [];
  private methodSet = new Set<string>();
  private readAt = 0;
  private phase: 'schema' | 'read' | 'done' = 'schema';
  private lastActivity = Date.now();
  private schemaAnswered = false;
  private timer: NodeJS.Timeout;

  constructor(
    private readonly send: (msg: Record<string, SscValue>) => void,
    private readonly note: (text: string) => void,
    private readonly fallback: () => Record<string, SscValue>,
    tickMs = 150,
  ) {
    this.note('Reading everything: listing the device\'s addresses (/osc/schema)…');
    this.timer = setInterval(() => this.tick(), tickMs);
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  stop(): void {
    clearInterval(this.timer);
    this.phase = 'done';
  }

  onMessage(msg: Record<string, SscValue>): void {
    const osc = msg.osc;
    if (isObject(osc) && Array.isArray(osc.schema)) {
      this.schemaAnswered = true;
      this.lastActivity = Date.now();
      for (const t of osc.schema) this.walk(t, []);
    }
    if (this.phase === 'read' && leaves(msg).length) this.lastActivity = Date.now();
  }

  private walk(node: SscValue, path: string[]): void {
    if (node === null) {
      const key = path.join('/');
      if (path.length && !SKIP.test(key) && !this.methodSet.has(key) && this.methods.length < MAX_METHODS) {
        this.methodSet.add(key);
        this.methods.push(path);
      }
      return;
    }
    if (!isObject(node)) return;
    const keys = Object.keys(node);
    if (!keys.length) {
      const key = path.join('/');
      if (!this.containers.has(key) && !SKIP.test(key) && this.containers.size < MAX_CONTAINERS) {
        this.containers.add(key);
        this.queue.push(path);
      }
      return;
    }
    for (const k of keys) this.walk(node[k]!, [...path, k]);
  }

  private tick(): void {
    const now = Date.now();
    if (this.phase === 'schema') {
      const next = this.queue.shift();
      if (next) {
        this.send({ osc: { schema: next.length ? [tree(next)] : null } });
        this.lastActivity = now;
        return;
      }
      if (now - this.lastActivity < QUIET_MS) return;
      if (!this.schemaAnswered || !this.methods.length) {
        this.note('No address list from the device (/osc/schema); reading the addresses RF Ranger knows instead.');
        for (const [path] of leaves(this.fallback())) this.walk(null, path.slice(1).split('/'));
      } else {
        this.note(`Found ${this.methods.length} addresses in ${this.containers.size} branches. Reading each one…`);
      }
      this.phase = 'read';
      return;
    }
    if (this.phase === 'read') {
      const batch = this.methods.slice(this.readAt, this.readAt + READS_PER_MESSAGE);
      if (batch.length) {
        this.readAt += batch.length;
        this.send(merge(...batch.map((p) => tree(p))));
        this.lastActivity = now;
        return;
      }
      if (now - this.lastActivity < QUIET_MS) return;
      this.note(`Read ${this.methods.length} addresses. Export the report when you're ready.`);
      this.stop();
    }
  }
}

/** Every address RF Ranger reads, for devices that don't answer schema queries. */
export function knownAddresses(family?: SennheiserFamilyId): Record<string, SscValue> {
  const families = family ? [SENNHEISER_FAMILIES[family]] : Object.values(SENNHEISER_FAMILIES);
  return merge(
    tree(['device', 'name']), tree(['device', 'identity', 'product']), tree(['device', 'identity', 'version']), tree(['device', 'identity', 'vendor']),
    ...families.flatMap((f) => [1, 2, 3, 4].map((n) => f.read(n))),
    ...families.map((f) => f.meters([1, 2, 3, 4])),
  );
}

/**
 * Meter subscriptions for a timed sample, one per family's meter layout so
 * an address one model lacks can't sink the other. Lifetime ends them even
 * if RF Ranger closes without cancelling.
 */
export function meterSubscriptions(family: SennheiserFamilyId | undefined, channels: number[], seconds: number, cancel = false): Record<string, SscValue>[] {
  const families = family ? [SENNHEISER_FAMILIES[family]] : Object.values(SENNHEISER_FAMILIES);
  return families.map((f) => {
    const sub = subscribe(f.meters(channels), { intervalMs: 1_000, lifetimeS: seconds + 2 });
    if (cancel) ((sub.osc as { state: { subscribe: Array<Record<string, SscValue>> } }).state.subscribe[0]!)['#'] = { cancel: true };
    return sub;
  });
}

/** Keys-seen entries for one reply: address → latest value, with the channel when the address names one. */
export function sscKeys(msg: Record<string, SscValue>): Array<{ key: string; channel?: number; value: string }> {
  const out = leaves(msg).map(([path, v]) => {
    const m = /^\/(?:m\/)?(?:rx|mates\/tx)(\d+)\//.exec(path);
    return { key: path, channel: m ? Number(m[1]) : undefined, value: JSON.stringify(v).slice(0, 300) };
  });
  for (const [path, code] of errors(msg)) out.push({ key: `${path} (error)`, channel: undefined, value: String(code) });
  return out;
}

/** Final address segments that can hold names or identifiers people may not want to share. */
const PRIVATE = /^(name|serial|location|hostname|mac|macs|ip|ipv4|ipv6|gateway|netmask|dns|user|username|contact|owner|label)$/i;

export function isPrivateAddress(path: string): boolean {
  return PRIVATE.test(path.split('/').pop() ?? '');
}

/** Remove names, serials and network identifiers from an SSC frame. */
export function redactSsc(text: string, host?: string): string {
  let out = text;
  try {
    const scrub = (v: SscValue, key?: string): SscValue => {
      if (key && PRIVATE.test(key) && v !== null && !isObject(v)) return Array.isArray(v) ? v.map(() => 'redacted') : 'redacted';
      if (Array.isArray(v)) return v.map((x) => scrub(x));
      if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
      return v;
    };
    out = JSON.stringify(scrub(JSON.parse(text) as SscValue));
  } catch {
    // a note, not a frame
  }
  out = out.replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, 'x.x.x.x').replace(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, 'xx:xx:xx:xx:xx:xx');
  if (host) out = out.split(host).join('redacted-host');
  return out;
}
