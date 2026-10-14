/**
 * A single metric value with its provenance. Missing data is never
 * represented as a number: a receiver that says "unknown" yields `absent`,
 * a family that can't report the metric yields `unsupported`, and nothing
 * heard yet is `unknown`. Staleness is judged at read time from `at`.
 */
export type Reading<T> =
  | { readonly state: 'ok'; readonly value: T; readonly at: number }
  | { readonly state: 'absent'; readonly at: number; readonly reason?: string }
  | { readonly state: 'unsupported' }
  | { readonly state: 'unknown' };

export const UNKNOWN: Reading<never> = { state: 'unknown' };
export const UNSUPPORTED: Reading<never> = { state: 'unsupported' };

export function ok<T>(value: T, at: number): Reading<T> {
  return { state: 'ok', value, at };
}

/** No value; `reason` says why when the device does, e.g. "calculating". */
export function absent(at: number, reason?: string): Reading<never> {
  return reason ? { state: 'absent', at, reason } : { state: 'absent', at };
}

/** The value, if the reading is `ok` and no older than `maxAgeMs`. */
export function freshValue<T>(r: Reading<T>, now: number, maxAgeMs: number): T | undefined {
  return r.state === 'ok' && now - r.at <= maxAgeMs ? r.value : undefined;
}
