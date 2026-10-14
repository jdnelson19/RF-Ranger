import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanningCenterLink } from '../src/integrations/planning-center/link.js';
import { handlePco } from '../src/server/pco-http.js';

const SECRET = 'super-secret-value-1234';

/** A fake Planning Center: accepts one app ID/secret pair, serves one account. */
function fakePco(opts: { appId?: string; orgId?: string; orgName?: string } = {}) {
  const good = 'Basic ' + Buffer.from(`${opts.appId ?? 'app-good-ab12'}:${SECRET}`).toString('base64');
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (new Headers(init?.headers).get('Authorization') !== good) return new Response(null, { status: 401 });
    const body = (data: unknown, included: unknown[] = []) => new Response(JSON.stringify({ data, included }), { status: 200 });
    if (url.pathname === '/services/v2') {
      return body({ type: 'Organization', id: opts.orgId ?? 'org1', attributes: { name: opts.orgName ?? 'Grace Church', time_zone: 'America/Chicago', secret: 'org-internal' } });
    }
    if (url.pathname === '/services/v2/service_types') {
      return body([
        { type: 'ServiceType', id: '17852', attributes: { name: 'Auditorium - EP' } },
        { type: 'ServiceType', id: '62044', attributes: { name: 'Special Services' } },
        { type: 'ServiceType', id: '1458130', attributes: { name: 'Special Services' } },
      ]);
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

function newLink(f: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-ranger-link-'));
  const paths = { credentialsPath: join(dir, 'planning-center.json'), settingsPath: join(dir, 'planning-center.settings.json') };
  return { link: new PlanningCenterLink({ ...paths, env, fetch: f }), ...paths };
}

describe('PlanningCenterLink', () => {
  it('saves a token only after Planning Center accepts it', async () => {
    const { link, credentialsPath } = newLink(fakePco());
    await expect(link.connect('app-good-ab12', 'wrong')).rejects.toThrow(/rejected this token/);
    expect(existsSync(credentialsPath)).toBe(false);

    const { status, serviceTypes } = await link.connect('  app-good-ab12 ', ` ${SECRET} `);
    expect(status).toMatchObject({ configured: true, connected: true, source: 'saved', tokenHint: 'ab12', organization: { name: 'Grace Church', timeZone: 'America/Chicago' } });
    expect(serviceTypes).toHaveLength(3);
    expect(JSON.parse(readFileSync(credentialsPath, 'utf8'))).toEqual({ appId: 'app-good-ab12', secret: SECRET });
  });

  it('never reports the secret, or the organization\'s own secret attribute', async () => {
    const { link } = newLink(fakePco());
    await link.connect('app-good-ab12', SECRET);
    const text = JSON.stringify(link.status());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('org-internal');
    expect(text).not.toContain('app-good');
  });

  it('follows a service type by ID, since names repeat', async () => {
    const { link } = newLink(fakePco());
    await link.connect('app-good-ab12', SECRET);
    expect((await link.setServiceType('1458130')).serviceType).toEqual({ id: '1458130', name: 'Special Services' });
    await expect(link.setServiceType('999')).rejects.toThrow(/not in this Planning Center account/);
  });

  it('forgets the service type when a different account is linked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-ranger-link-'));
    const paths = { credentialsPath: join(dir, 'c.json'), settingsPath: join(dir, 's.json') };
    const first = new PlanningCenterLink({ ...paths, env: {}, fetch: fakePco() });
    await first.connect('app-good-ab12', SECRET);
    await first.setServiceType('17852');
    const second = new PlanningCenterLink({ ...paths, env: {}, fetch: fakePco({ appId: 'app-other-zz99', orgId: 'org2', orgName: 'Other Church' }) });
    const { status } = await second.connect('app-other-zz99', SECRET);
    expect(status.organization?.name).toBe('Other Church');
    expect(status.serviceType).toBeUndefined();
  });

  it('disconnects by deleting the token and choices', async () => {
    const { link, credentialsPath, settingsPath } = newLink(fakePco());
    await link.connect('app-good-ab12', SECRET);
    await link.setServiceType('17852');
    expect(link.disconnect()).toMatchObject({ configured: false, connected: false });
    expect(existsSync(credentialsPath)).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({});
  });

  it('leaves environment credentials alone', async () => {
    const { link } = newLink(fakePco(), { PCO_APP_ID: 'app-good-ab12', PCO_SECRET: SECRET });
    expect((await link.refresh())).toMatchObject({ connected: true, source: 'environment' });
    expect(() => link.disconnect()).toThrow(/environment variables/);
    await expect(link.connect('x', 'y')).rejects.toThrow(/environment variables/);
  });
});

describe('/api/pco', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serve() {
    const { link } = newLink(fakePco());
    server = http.createServer((req, res) => void handlePco(link, req, res, new URL(req.url ?? '/', 'http://localhost')));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/pco`;
  }

  it('connects with a JSON POST from this computer and reports status without the secret', async () => {
    const base = await serve();
    const res = await fetch(`${base}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'app-good-ab12', secret: SECRET }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).status.connected).toBe(true);
    expect((await (await fetch(base)).json()).organization.name).toBe('Grace Church');
  });

  it('refuses other websites and non-JSON changes', async () => {
    const base = await serve();
    expect((await fetch(base, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${base}/disconnect`, { method: 'POST', body: '{}' })).status).toBe(415);
  });

  it('explains a rejected token in words', async () => {
    const base = await serve();
    const res = await fetch(`${base}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'nope', secret: 'nope' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected this token/);
  });
});
