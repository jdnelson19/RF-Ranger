/**
 * Sennheiser Sound Control Protocol (SSC), version 1: JSON messages, one per
 * UDP datagram, default port 45. Used by Digital 6000 (EM 6000) and, when
 * "3rd party media control access" is set to Legacy (SSCv1), EW-DX.
 *
 * Messages are address trees: {"rx1":{"name":null}} asks for /rx1/name and
 * the reply carries the value in the same place. Errors come back as
 * {"osc":{"error":[{"rx1":{"name":[404,{"desc":"address not found"}]}}]}}.
 * Sources: Sennheiser "SSC Developer's guide" for Digital 6000 (TI 1109 v2.2)
 * and for EW-DX (11/2023).
 *
 * Pure helpers here; the UDP connection is in connection.ts.
 */

export const SSC_PORT = 45;

export type SscValue = null | boolean | number | string | SscValue[] | { [key: string]: SscValue };

/** ["rx1","skx","battery"] → {"rx1":{"skx":{"battery":value}}} */
export function tree(path: string[], value: SscValue = null): Record<string, SscValue> {
  let out: SscValue = value;
  for (let i = path.length - 1; i >= 0; i--) out = { [path[i]!]: out };
  return out as Record<string, SscValue>;
}

/** Merge address trees into one message (SSC allows asking for many addresses at once). */
export function merge(...trees: Record<string, SscValue>[]): Record<string, SscValue> {
  const out: Record<string, SscValue> = {};
  for (const t of trees) mergeInto(out, t);
  return out;
}

function mergeInto(into: Record<string, SscValue>, from: Record<string, SscValue>): void {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k];
    if (isObject(cur) && isObject(v)) mergeInto(cur, v);
    else into[k] = v;
  }
}

const isObject = (v: SscValue | undefined): v is { [key: string]: SscValue } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every leaf value in a reply, as "/a/b/c" → value. Arrays are values, not
 * branches (/mm, battery, warnings). The "osc" branch is skipped: errors are
 * read with errors(), and subscription echoes aren't device values.
 */
export function leaves(msg: Record<string, SscValue>): Array<[path: string, value: SscValue]> {
  const out: Array<[string, SscValue]> = [];
  const walk = (node: SscValue, path: string) => {
    if (isObject(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k.trim()}`);
    } else {
      out.push([path, node]);
    }
  };
  for (const [k, v] of Object.entries(msg)) if (k !== 'osc') walk(v, `/${k.trim()}`);
  return out;
}

/** The addresses an error reply names, with their error codes (404 address not found, 424 transmitter not present, …). */
export function errors(msg: Record<string, SscValue>): Array<[path: string, code: number]> {
  const osc = msg.osc;
  if (!isObject(osc) || !Array.isArray(osc.error)) return [];
  const out: Array<[string, number]> = [];
  const walk = (node: SscValue, path: string) => {
    if (Array.isArray(node) && typeof node[0] === 'number') out.push([path || '/', node[0]]);
    else if (isObject(node)) for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
  };
  for (const e of osc.error) walk(e, '');
  return out;
}

/**
 * Subscribe to addresses. `intervalMs` > 0 asks for a notification at least
 * that often even when nothing changes (metering); 0 means on change only.
 * Subscriptions lapse after `lifetimeS`, so the connection renews them.
 */
export function subscribe(addresses: Record<string, SscValue>, opts: { intervalMs?: number; lifetimeS?: number } = {}): Record<string, SscValue> {
  const every = opts.intervalMs ?? 0;
  return { osc: { state: { subscribe: [{ '#': { min: every, max: every, count: 100_000, lifetime: opts.lifetimeS ?? 60 }, ...addresses }] } } };
}
