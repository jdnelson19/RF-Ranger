import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminAuth, handleAdmin, setAdminPassword } from '../src/server/admin.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'rfr-admin-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'admin.json');
}

/** A request from another screen on the network (a Pi's TV, an iPad). */
const remote = (cookie?: string, origin?: string) =>
  ({
    socket: { remoteAddress: '192.168.1.40' },
    headers: { host: 'rf-ranger.local:8058', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
  }) as unknown as http.IncomingMessage;

const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8058' } } as unknown as http.IncomingMessage;

describe('AdminAuth', () => {
  it('with no password, admin is this computer only', () => {
    const admin = new AdminAuth(tempPath());
    expect(admin.passwordSet()).toBe(false);
    expect(admin.allows(local)).toBe(true);
    expect(admin.allows(remote())).toBe(false);
    expect(() => admin.login('anything')).toThrow(/No admin password/);
  });

  it('stores a salted hash, never the password', () => {
    const path = tempPath();
    setAdminPassword(path, 'soundcheck-42');
    expect(readFileSync(path, 'utf8')).not.toContain('soundcheck-42');
    expect(() => setAdminPassword(path, 'short')).toThrow(/at least 8/);
  });

  it('lets a signed-in screen in, from this server’s own pages only', () => {
    const path = tempPath();
    setAdminPassword(path, 'soundcheck-42');
    const admin = new AdminAuth(path);
    expect(admin.login('wrong-password')).toBeUndefined();
    const token = admin.login('soundcheck-42')!;
    expect(token).toBeTruthy();
    expect(admin.allows(remote(`rfr_admin=${token}`))).toBe(true);
    expect(admin.allows(remote(`rfr_admin=${token}`, 'http://rf-ranger.local:8058'))).toBe(true);
    expect(admin.allows(remote(`rfr_admin=${token}`, 'https://evil.example'))).toBe(false);
    expect(admin.allows(remote('rfr_admin=made-up'))).toBe(false);
  });

  it('signs everyone out when the password changes, and sessions expire', () => {
    const path = tempPath();
    setAdminPassword(path, 'soundcheck-42');
    let now = 1_000;
    const admin = new AdminAuth(path, () => now);
    const token = admin.login('soundcheck-42')!;
    now += 31 * 24 * 60 * 60 * 1000;
    expect(admin.allows(remote(`rfr_admin=${token}`))).toBe(false);

    const again = admin.login('soundcheck-42')!;
    setAdminPassword(path, 'new-password-1');
    expect(admin.allows(remote(`rfr_admin=${again}`))).toBe(false);
  });

  it('pauses sign-in after five wrong passwords in a minute', () => {
    const path = tempPath();
    setAdminPassword(path, 'soundcheck-42');
    let now = 0;
    const admin = new AdminAuth(path, () => now);
    for (let i = 0; i < 5; i++) admin.login('nope-nope');
    expect(() => admin.login('soundcheck-42')).toThrow(/Too many/);
    now += 61_000;
    expect(admin.login('soundcheck-42')).toBeTruthy();
  });
});

describe('/api/admin', () => {
  async function serve(admin: AdminAuth) {
    const server = http.createServer((req, res) => void handleAdmin(admin, req, res, new URL(req.url ?? '/', 'http://localhost')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/admin`;
  }
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('signs in with a cookie and out again', async () => {
    const path = tempPath();
    setAdminPassword(path, 'soundcheck-42');
    const base = await serve(new AdminAuth(path));
    expect((await (await fetch(base)).json()).passwordSet).toBe(true);
    expect((await post(`${base}/login`, { password: 'wrong-password' })).status).toBe(401);

    const res = await post(`${base}/login`, { password: 'soundcheck-42' });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^rfr_admin=[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
    const session = cookie.split(';')[0]!;
    expect((await (await fetch(base, { headers: { cookie: session } })).json()).signedIn).toBe(true);

    await post(`${base}/logout`, {}, { cookie: session });
    expect((await (await fetch(base, { headers: { cookie: session } })).json()).signedIn).toBe(false);
  });

  it('refuses sign-in from other websites and non-JSON posts', async () => {
    const path = tempPath();
    setAdminPassword(path, 'soundcheck-42');
    const base = await serve(new AdminAuth(path));
    expect((await post(`${base}/login`, { password: 'soundcheck-42' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${base}/login`, { method: 'POST', body: '{"password":"soundcheck-42"}' })).status).toBe(415);
  });
});
