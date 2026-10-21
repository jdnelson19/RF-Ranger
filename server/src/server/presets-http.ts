/**
 * /api/presets: create, change and delete show presets.
 *
 * Unlike the Device Inspector and Planning Center settings, presets can be
 * edited from any engineer screen on the network (an RF tech's iPad): they
 * only change what is displayed, never the hardware. Other websites still
 * can't touch them: changes must be JSON (forcing a CORS preflight we never
 * answer), any Origin must be the RF Ranger page itself, and the Host must be
 * a local address, so a public domain re-pointed at this machine (DNS
 * rebinding) is refused.
 *
 *   POST /api/presets               { name, slots, channels? }   create
 *   POST /api/presets/:id           { name?, slots?, channels? } change
 *   POST /api/presets/:id/delete    {}                           delete
 *   POST /api/presets/pickup        { id | null }                what #/pickup shows (null: every channel)
 *   POST /api/presets/star          { key, on }                  star a channel (Planning Center screen)
 *   POST /api/presets/auto-star     { on }                       a sync stars the mics it fills (default on)
 *   channels: { "<receiverId/channel>": { nickname?, waveform? } }, pickupColumns: 1-8 | null (auto)
 * Presets are read from the snapshot (`presets`), so every screen updates live.
 */
import type http from 'node:http';
import { readJson } from './inspector.js';
import { PresetError, type PresetStore } from './presets.js';

export async function handlePresets(store: PresetStore, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return json(405, { error: 'Presets are read from the snapshot; changes are POSTs.' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'Expected JSON' });
  if (!isSameOriginWrite(req)) return json(403, { error: 'Presets can only be changed from the RF Ranger page.' });

  const parts = url.pathname.replace(/^\/api\/presets\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    const body = (await readJson(req)) as Record<string, unknown>;
    // Before :id routes; preset ids are UUIDs, so they never clash with "pickup".
    if (parts.length === 1 && parts[0] === 'pickup') return json(200, { pickupPreset: store.setPickupPreset(body.id) ?? null });
    if (parts.length === 1 && parts[0] === 'star') return json(200, { preset: store.star(body.key, body.on === true) ?? null });
    if (parts.length === 1 && parts[0] === 'auto-star') return json(200, { autoStar: store.setAutoStar(body.on === true) });
    if (parts.length === 0) return json(201, store.create({ name: body.name, slots: body.slots, channels: body.channels, pickupColumns: body.pickupColumns }));
    if (parts.length === 1) return json(200, store.update(parts[0]!, { name: body.name, slots: body.slots, channels: body.channels, pickupColumns: body.pickupColumns }));
    if (parts.length === 2 && parts[1] === 'delete') {
      store.delete(parts[0]!);
      return json(200, { deleted: parts[0] });
    }
    json(404, { error: 'Not found' });
  } catch (err) {
    if (err instanceof PresetError) return json(400, { error: err.message });
    json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * The request comes from the RF Ranger page (any device on the network), not
 * another website: a local Host, and an Origin, when sent, for that same host.
 */
export function isSameOriginWrite(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!host || !isLocalHost(host.replace(/:\d+$/, ''))) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin POSTs from older browsers, curl
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** IP literals, localhost, mDNS names (mac.local) and bare computer names: never a public domain. */
function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true; // IPv6 literal
  return /^[a-z0-9-]+$/.test(hostname); // single-label computer name
}
