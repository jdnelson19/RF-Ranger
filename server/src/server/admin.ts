/**
 * Remote admin. The settings that answer only the computer running RF Ranger
 * (Planning Center, the Device Inspector, Add and Forget device) can also be
 * used from another screen once it signs in with the admin password. This is
 * for headless installs such as a Raspberry Pi behind a TV, where nobody sits
 * at "the computer running RF Ranger". With no password set nothing changes.
 *
 *   GET  /api/admin          { local, passwordSet, signedIn }
 *   POST /api/admin/login    { password }   sets the session cookie
 *   POST /api/admin/logout   {}
 *
 * The password is set from the command line (rf-ranger --set-password), never
 * over the network, and stored as a salted scrypt hash.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isLocalRequest, readJson } from './inspector.js';

const COOKIE = 'rfr_admin';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_LENGTH = 8;
/** Wrong passwords allowed per minute, across every screen, before sign-in pauses. */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export function adminPath(home = homedir()): string {
  return join(home, '.rf-ranger', 'admin.json');
}

interface Stored {
  salt: string;
  hash: string;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

/** Save (or with null, remove) the admin password. Signs out every remote screen on the next request. */
export function setAdminPassword(path: string, password: string | null): void {
  if (password === null) {
    rmSync(path, { force: true });
    return;
  }
  if (password.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters.`);
  const salt = randomBytes(16);
  const stored: Stored = { salt: salt.toString('base64'), hash: hashPassword(password, salt).toString('base64') };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stored) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: no POSIX modes
  }
}

export class AdminAuth {
  private readonly sessions = new Map<string, number>();
  private failures: number[] = [];
  /** The stored hash the sessions were issued under; a new password signs everyone out. */
  private sessionsFor?: string;

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  private stored(): Stored | undefined {
    if (!this.path || !existsSync(this.path)) return undefined;
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Stored>;
      return typeof s.salt === 'string' && typeof s.hash === 'string' ? (s as Stored) : undefined;
    } catch {
      return undefined;
    }
  }

  passwordSet(): boolean {
    return this.stored() !== undefined;
  }

  /** This computer, or a screen signed in as admin (from this RF Ranger's own pages). */
  allows(req: http.IncomingMessage): boolean {
    return isLocalRequest(req) || this.signedIn(req);
  }

  signedIn(req: http.IncomingMessage): boolean {
    const stored = this.stored();
    if (!stored) return false;
    if (this.sessionsFor !== stored.hash) {
      this.sessions.clear();
      this.sessionsFor = stored.hash;
    }
    const token = readCookie(req, COOKIE);
    const expires = token ? this.sessions.get(token) : undefined;
    if (expires === undefined) return false;
    if (expires < this.now()) {
      this.sessions.delete(token!);
      return false;
    }
    // The cookie is SameSite=Strict; an Origin, when sent, must still be this server.
    return sameOrigin(req);
  }

  /** A session token for the right password; undefined for a wrong one. Throws while sign-in is paused. */
  login(password: string): string | undefined {
    const stored = this.stored();
    if (!stored) throw new AdminError('No admin password is set. Set one on the computer running RF Ranger: rf-ranger --set-password', 403);
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < LOCKOUT_MS);
    if (this.failures.length >= MAX_FAILURES) throw new AdminError('Too many wrong passwords. Wait a minute, then try again.', 429);
    const expected = Buffer.from(stored.hash, 'base64');
    const given = hashPassword(password, Buffer.from(stored.salt, 'base64'));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.failures.push(now);
      return undefined;
    }
    if (this.sessionsFor !== stored.hash) {
      this.sessions.clear();
      this.sessionsFor = stored.hash;
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_MS);
    return token;
  }

  logout(req: http.IncomingMessage): void {
    const token = readCookie(req, COOKIE);
    if (token) this.sessions.delete(token);
  }
}

export class AdminError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function handleAdmin(admin: AdminAuth, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  const route = url.pathname.replace(/^\/api\/admin\/?/, '');
  const state = () => ({ local: isLocalRequest(req), passwordSet: admin.passwordSet(), signedIn: admin.signedIn(req) });

  if (req.method === 'GET' && route === '') return json(200, state());
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  // JSON only (forces a CORS preflight), and only from this server's own pages.
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'Expected JSON' });
  if (!sameOrigin(req)) return json(403, { error: 'Sign in from RF Ranger itself.' });

  try {
    if (route === 'login') {
      const body = (await readJson(req)) as { password?: unknown };
      const token = admin.login(typeof body.password === 'string' ? body.password : '');
      if (!token) return json(401, { error: 'That password isn’t right.' });
      const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
      return json(200, { ...state(), signedIn: true }, { 'set-cookie': cookie });
    }
    if (route === 'logout') {
      admin.logout(req);
      return json(200, { ...state(), signedIn: false }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    json(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof AdminError) return json(err.status, { error: err.message });
    json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** No Origin (a plain navigation or download link), or an Origin naming the Host this request came to. */
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
