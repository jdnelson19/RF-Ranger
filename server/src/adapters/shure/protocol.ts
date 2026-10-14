/**
 * Framing and tokenising for Shure's third-party control protocol
 * (`< REP 1 BATT_BARS 004 >`). See docs/shure-protocol.md.
 */

/**
 * Splits a TCP byte stream into whole `< ... >` messages. Messages can arrive
 * split across or merged within reads, and `{...}` string values may legally
 * contain `<` or `>` (Axient channel/device names), so braces are tracked.
 */
export class ShureFramer {
  private buf = '';

  constructor(private readonly maxBuffer = 64 * 1024) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let start = -1;
    let inBrace = false;
    let consumed = 0;

    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (start === -1) {
        if (c === '<') start = i;
        else consumed = i + 1; // noise between messages
        continue;
      }
      if (c === '{') inBrace = true;
      else if (c === '}') inBrace = false;
      else if (c === '>' && !inBrace) {
        out.push(this.buf.slice(start, i + 1));
        start = -1;
        consumed = i + 1;
      }
    }

    this.buf = this.buf.slice(consumed);
    if (this.buf.length > this.maxBuffer) this.buf = '';
    return out;
  }
}

export type ShureMessage =
  | { kind: 'rep'; channel: number | undefined; key: string; args: string[] }
  | { kind: 'sample'; channel: number; args: string[] }
  | { kind: 'err' }
  | { kind: 'unknown'; tokens: string[] };

/** Splits on whitespace, keeping `{...}` as one token with its padding trimmed. */
export function tokenize(body: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
    } else if (c === '{') {
      const end = body.indexOf('}', i + 1);
      const stop = end === -1 ? body.length : end;
      tokens.push(body.slice(i + 1, stop).trimEnd());
      i = stop + 1;
    } else {
      let j = i;
      while (j < body.length && !/\s/.test(body[j]!)) j++;
      tokens.push(body.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

export function parseMessage(frame: string): ShureMessage {
  const body = frame.replace(/^\s*</, '').replace(/>\s*$/, '');
  const tokens = tokenize(body);
  const [type, second, third] = tokens;

  if ((type === 'REP' || type === 'REPORT') && second !== undefined) {
    if (second === 'ERR') return { kind: 'err' };
    if (/^\d+$/.test(second)) {
      if (third === undefined) return { kind: 'unknown', tokens };
      return { kind: 'rep', channel: Number(second), key: third, args: tokens.slice(3) };
    }
    return { kind: 'rep', channel: undefined, key: second, args: tokens.slice(2) };
  }

  if (type === 'SAMPLE' && second !== undefined && /^\d+$/.test(second) && third === 'ALL') {
    return { kind: 'sample', channel: Number(second), args: tokens.slice(3) };
  }

  return { kind: 'unknown', tokens };
}

export function getCommand(channel: number | undefined, key: string): string {
  return channel === undefined ? `< GET ${key} >` : `< GET ${channel} ${key} >`;
}

export function meterRateCommand(channel: number, ms: number): string {
  return `< SET ${channel} METER_RATE ${String(Math.round(ms)).padStart(5, '0')} >`;
}
