/**
 * What's live right now in Planning Center (Services Live), for the pickup
 * clock and the engineer banner, and who is leading it. Pure; shared with
 * the web UI.
 */

export interface LiveNow {
  /** The RF Ranger service (Planning Center service type) that is live. */
  serviceName: string;
  planTitle?: string;
  item: { title: string; startedAt: string; endsAt: string; lengthSec: number };
  next?: { title: string; lengthSec: number };
  /** The live item's Leader note as written, e.g. "Sam/BGVs/Band". */
  leader?: string;
}

/** "Sam/BGVs/Band", "Pastor Alex Morgan & Jo", "Lee, Kim" → the separate names. */
export function leaderNames(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .split(/\s*(?:\/|,|&|\+|;|\n|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Whether a leader note names this person. Matches a full name, a full name
 * after a title ("Pastor Alex Morgan"), or a bare first name ("Sam") when no
 * one else in `others` shares that first name.
 */
export function namesPerson(leader: string, person: string, others: string[] = []): boolean {
  const full = norm(person);
  if (!full) return false;
  const first = full.split(' ')[0]!;
  const firstShared = others.some((o) => norm(o) !== full && norm(o).split(' ')[0] === first);
  return leaderNames(leader).some((raw) => {
    const name = norm(raw);
    if (!name) return false;
    if (name === full || name.endsWith(` ${full}`)) return true;
    return !name.includes(' ') && name === first && !firstShared;
  });
}
