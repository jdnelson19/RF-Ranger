import { existsSync } from 'node:fs';
import type http from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';
import { loadConfig, normalizeConfig, type Config } from './config.js';
import { startDemo } from './demo.js';
import { startHttp } from './http.js';
import { Inspector } from './inspector.js';
import { LiveManager, type LiveTarget } from './live.js';
import { Runtime } from './runtime.js';
import type { RunMode } from './snapshot.js';

export interface StartOptions {
  mode: RunMode;
  /** Defaults to the config file's port, else 8058. */
  port?: number;
  /** Config mode: path to the show config. */
  configPath?: string;
  /** Live mode. */
  targets?: LiveTarget[];
  discover?: boolean;
  webDir?: string;
  /** Running as the desktop app: enables Quit from the UI on this computer. */
  app?: { onQuit: () => void };
  log?: (msg: string) => void;
}

export interface Running {
  port: number;
  mode: RunMode;
  config: Config;
  server: http.Server;
  /** Switch metering off, close every device, stop serving. */
  stop: () => Promise<void>;
}

/**
 * Start RF Ranger: devices, discovery and the web server. The HTTP port is
 * bound before any device is contacted, so a port clash fails fast without
 * touching receivers. Shared by the CLI (index.ts) and the desktop app.
 */
export async function startRfRanger(opts: StartOptions): Promise<Running> {
  const log = opts.log ?? ((m: string) => console.log(m));

  let config: Config;
  let stopDemo: (() => Promise<void>) | undefined;
  if (opts.mode === 'demo') {
    const demo = await startDemo(opts.port ?? 8058);
    config = demo.config;
    stopDemo = demo.stop;
  } else if (opts.mode === 'live') {
    config = normalizeConfig({ port: opts.port });
  } else {
    const path = resolve(opts.configPath ?? 'rf-ranger.config.json');
    if (!existsSync(path)) throw new Error(`No config at ${path}`);
    config = loadConfig(path);
    if (opts.port !== undefined) config.port = opts.port;
    // Photos are relative to the config file, not wherever we were started from.
    if (config.photosDir && !isAbsolute(config.photosDir)) config.photosDir = resolve(dirname(path), config.photosDir);
  }

  const runtime = new Runtime(config, opts.mode);
  const inspector = new Inspector(runtime);
  let server: http.Server;
  try {
    server = await startHttp(runtime, { port: config.port, webDir: opts.webDir, photosDir: config.photosDir, inspector, onQuit: opts.app?.onQuit });
  } catch (err) {
    await stopDemo?.();
    throw err;
  }
  runtime.app = opts.app !== undefined;
  runtime.start();

  let liveManager: LiveManager | undefined;
  if (opts.mode === 'live') {
    liveManager = new LiveManager(runtime, {
      discover: opts.discover ?? true,
      targets: opts.targets ?? [],
      log: (m) => log(`  ${m}`),
    });
    await liveManager.start();
  }

  const label = { demo: '(DEMO: simulated hardware) ', live: '(live: auto-discovery) ', config: '' }[opts.mode];
  log(`RF Ranger ${label}on http://localhost:${config.port}`);
  if (opts.mode !== 'live') log(`  ${config.receivers.length} receivers, ${config.chargers.length} chargers, ${config.slots.length} slots`);
  if (opts.webDir && !existsSync(opts.webDir)) log(`  Web UI not built at ${opts.webDir} (cd web && npm run build), or use the Vite dev server.`);

  return {
    port: config.port,
    mode: opts.mode,
    config,
    server,
    stop: async () => {
      liveManager?.stop();
      await inspector.closeAll();
      server.close();
      await runtime.stop();
      await stopDemo?.();
    },
  };
}
