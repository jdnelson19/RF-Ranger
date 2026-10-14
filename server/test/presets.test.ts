import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PresetStore } from '../src/server/presets.js';
import { handlePresets } from '../src/server/presets-http.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'rf-ranger-presets-')), 'show-presets.json');

describe('PresetStore', () => {
  it('creates, renames, reorders and deletes, saving each change', () => {
    const path = tmpFile();
    const store = new PresetStore(path, () => 1000);
    let changes = 0;
    store.on('change', () => changes++);

    const worship = store.create({ name: '  Worship  ', slots: ['AD4Q-A/1', 'AD4Q-A/2', 'AD4Q-A/1'] });
    expect(worship).toMatchObject({ name: 'Worship', slots: ['AD4Q-A/1', 'AD4Q-A/2'], updatedAt: 1000 });

    store.update(worship.id, { slots: ['AD4Q-A/2', 'AD4Q-A/1'] });
    store.update(worship.id, { name: 'Worship set' });
    expect(new PresetStore(path).list()).toEqual([{ ...worship, name: 'Worship set', slots: ['AD4Q-A/2', 'AD4Q-A/1'] }]);

    store.delete(worship.id);
    expect(new PresetStore(path).list()).toEqual([]);
    expect(changes).toBe(4);
  });

  it('refuses empty names, empty presets, and duplicate names', () => {
    const store = new PresetStore();
    expect(() => store.create({ name: ' ', slots: ['a/1'] })).toThrow(/name/);
    expect(() => store.create({ name: 'Message', slots: [] })).toThrow(/at least one channel/);
    expect(() => store.create({ name: 'Message', slots: 'a/1' })).toThrow(/list of channels/);
    store.create({ name: 'Message', slots: ['a/1'] });
    expect(() => store.create({ name: 'message', slots: ['a/2'] })).toThrow(/already exists/);
  });

  it('keeps channels that are offline right now, so a preset survives a receiver being down', () => {
    const store = new PresetStore();
    expect(store.create({ name: 'Band', slots: ['ULXD4D-2/1', 'ULXD4D-2/2'] }).slots).toEqual(['ULXD4D-2/1', 'ULXD4D-2/2']);
  });

  it('skips a damaged entry in the file instead of losing every preset', () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ version: 1, presets: [{ id: 'x', name: 'Good', slots: ['a/1'], updatedAt: 1 }, { id: 'y', name: '', slots: [] }] }));
    expect(new PresetStore(path).list().map((p) => p.name)).toEqual(['Good']);
    writeFileSync(path, 'not json');
    expect(new PresetStore(path).list()).toEqual([]);
  });

  it('writes a readable file', () => {
    const path = tmpFile();
    new PresetStore(path).create({ name: 'Message', slots: ['AD4Q-A/3'] });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, presets: [{ name: 'Message', slots: ['AD4Q-A/3'] }] });
  });
});

describe('/api/presets', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serve() {
    const store = new PresetStore();
    server = http.createServer((req, res) => void handlePresets(store, req, res, new URL(req.url ?? '/', 'http://localhost')));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server!.address() as AddressInfo).port;
    return { store, base: `http://127.0.0.1:${port}/api/presets`, port };
  }

  /** Raw request so Host and Origin can be set the way another site or a rebinding attack would. */
  function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return new Promise((done, fail) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => done({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined }));
      });
      req.on('error', fail);
      req.end(JSON.stringify(body));
    });
  }

  it('creates, updates and deletes from an engineer screen on the network', async () => {
    const { store, port } = await serve();
    const host = { host: `192.168.1.40:${port}`, origin: `http://192.168.1.40:${port}` };
    const created = await post(port, '/api/presets', { name: 'Worship', slots: ['AD4Q-A/1'] }, host);
    expect(created.status).toBe(201);
    expect((await post(port, `/api/presets/${created.body.id}`, { slots: ['AD4Q-A/2', 'AD4Q-A/1'] }, host)).status).toBe(200);
    expect(store.list()[0]!.slots).toEqual(['AD4Q-A/2', 'AD4Q-A/1']);
    expect((await post(port, `/api/presets/${created.body.id}/delete`, {}, host)).status).toBe(200);
    expect(store.list()).toEqual([]);
  });

  it('explains bad input in words', async () => {
    const { port } = await serve();
    const r = await post(port, '/api/presets', { name: 'Empty', slots: [] }, { host: `localhost:${port}` });
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/at least one channel/) } });
  });

  it('refuses other websites, DNS rebinding and non-JSON requests', async () => {
    const { store, base, port } = await serve();
    const body = { name: 'Evil', slots: ['a/1'] };
    expect((await post(port, '/api/presets', body, { host: `localhost:${port}`, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(port, '/api/presets', body, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).status).toBe(403);
    expect((await fetch(base, { method: 'POST', body: JSON.stringify(body) })).status).toBe(415);
    expect((await fetch(base)).status).toBe(405);
    expect(store.list()).toEqual([]);
  });

  it('accepts a Mac reached by its .local or bare computer name', async () => {
    const { port } = await serve();
    expect((await post(port, '/api/presets', { name: 'A', slots: ['a/1'] }, { host: `production-mac.local:${port}`, origin: `http://production-mac.local:${port}` })).status).toBe(201);
    expect((await post(port, '/api/presets', { name: 'B', slots: ['a/1'] }, { host: `foh-mac:${port}` })).status).toBe(201);
  });
});
