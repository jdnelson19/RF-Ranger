import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PlanningCenterLink } from '../integrations/planning-center/link.js';
import { handleInspector, isLocalRequest, type Inspector } from './inspector.js';
import { handlePco } from './pco-http.js';
import type { Runtime } from './runtime.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export interface HttpOptions {
  port: number;
  host?: string;
  /** Built web UI (web/dist). */
  webDir?: string;
  photosDir?: string;
  /** Max snapshot pushes per second while data is changing. */
  pushHz?: number;
  /** Local-only device inspector (see inspector.ts). */
  inspector?: Inspector;
  /** Desktop app: POST /api/app/quit from this computer stops RF Ranger. */
  onQuit?: () => void;
  /** Local-only Planning Center settings (see pco-http.ts). */
  planningCenter?: PlanningCenterLink;
}

/**
 * Read-only API: GET /api/snapshot and a /ws stream of snapshots, safe to
 * expose to the production network for TVs and tablets. The exceptions,
 * /api/inspector and /api/pco, answer only the computer running RF Ranger.
 */
export function startHttp(runtime: Runtime, opts: HttpOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(runtime.snapshot()));
      return;
    }

    if (url.pathname === '/api/app/quit' && opts.onQuit) {
      // Same guard as the inspector; requiring a JSON body forces a CORS
      // preflight, so no other website can make this request.
      const json = (req.headers['content-type'] ?? '').startsWith('application/json');
      if (req.method !== 'POST' || !json || !isLocalRequest(req)) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' }).end('{"quitting":true}');
      setImmediate(opts.onQuit);
      return;
    }

    if (url.pathname.startsWith('/api/inspector') && opts.inspector) {
      void handleInspector(opts.inspector, req, res, url);
      return;
    }

    if (url.pathname.startsWith('/api/pco') && opts.planningCenter) {
      void handlePco(opts.planningCenter, req, res, url);
      return;
    }

    if (url.pathname.startsWith('/photos/') && opts.photosDir) {
      serveFile(res, opts.photosDir, decodeURIComponent(url.pathname.slice('/photos/'.length)), false);
      return;
    }

    if (opts.webDir) {
      serveFile(res, opts.webDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1), true);
      return;
    }

    res.writeHead(404).end('Not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE); they're handled
  // by the listen promise below, so don't let them crash the process here.
  wss.on('error', () => {});
  const clients = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(runtime.snapshot()));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  // Push on change (throttled), and at least once a second so ages and
  // staleness keep advancing on screen even when nothing reports.
  let dirty = true;
  runtime.on('dirty', () => { dirty = true; });
  const pushEvery = 1000 / (opts.pushHz ?? 5);
  let lastPush = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (!clients.size || (!dirty && now - lastPush < 1_000)) return;
    dirty = false;
    lastPush = now;
    const payload = JSON.stringify(runtime.snapshot(now));
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
  }, pushEvery);
  server.on('close', () => clearInterval(timer));

  return new Promise((resolveListen, rejectListen) => {
    // e.g. EADDRINUSE: reject rather than crash, so callers can react.
    server.once('error', (err) => {
      server.close();
      rejectListen(err);
    });
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolveListen(server));
  });
}

function serveFile(res: http.ServerResponse, root: string, rel: string, spaFallback: boolean): void {
  const base = resolve(root);
  let path = normalize(join(base, rel));
  if (path !== base && !path.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    if (!spaFallback) {
      res.writeHead(404).end('Not found');
      return;
    }
    path = join(base, 'index.html');
    if (!existsSync(path)) {
      res.writeHead(404).end('Web UI not built. Run: cd web && npm run build');
      return;
    }
  }
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const cache = path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  createReadStream(path).pipe(res);
}
