/**
 * RF Ranger server.
 *
 *   npm start -- --config rf-ranger.config.json     configured show
 *   npm run live                                    find Shure devices on the network
 *   npm run live -- --receiver 10.0.1.20            ...plus/or devices by address
 *   npm run demo                                    simulated hardware
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, normalizeConfig, type Config } from './server/config.js';
import { startDemo } from './server/demo.js';
import { startHttp } from './server/http.js';
import { LiveManager, parseTarget } from './server/live.js';
import { Runtime } from './server/runtime.js';
import type { RunMode } from './server/snapshot.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    demo: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    receiver: { type: 'string', short: 'r', multiple: true },
    charger: { type: 'string', multiple: true },
    'no-discover': { type: 'boolean', default: false },
    port: { type: 'string', short: 'p' },
    web: { type: 'string' },
  },
});

const port = values.port ? Number(values.port) : 8058;
const targets = [
  ...(values.receiver ?? []).map((s) => parseTarget(s)),
  ...(values.charger ?? []).map((s) => parseTarget(s, true)),
];
const live = values.live || targets.length > 0;
const mode: RunMode = values.demo ? 'demo' : live ? 'live' : 'config';

let config: Config;
let stopDemo: (() => Promise<void>) | undefined;
if (mode === 'demo') {
  const demo = await startDemo(port);
  config = demo.config;
  stopDemo = demo.stop;
} else if (mode === 'live') {
  config = normalizeConfig({ port });
} else {
  const path = resolve(values.config ?? 'rf-ranger.config.json');
  if (!existsSync(path)) {
    console.error(`No config at ${path}.`);
    console.error('  npm run live      find Shure devices on the network (no config needed)');
    console.error('  npm run demo      try it with simulated hardware');
    process.exit(1);
  }
  config = loadConfig(path);
  if (values.port) config.port = port;
}

const webDir = values.web ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const runtime = new Runtime(config, mode);
runtime.start();

let liveManager: LiveManager | undefined;
if (mode === 'live') {
  liveManager = new LiveManager(runtime, {
    discover: !values['no-discover'],
    targets,
    log: (m) => console.log(`  ${m}`),
  });
  await liveManager.start();
}

const server = await startHttp(runtime, { port: config.port, webDir, photosDir: config.photosDir });

const label = { demo: '(DEMO: simulated hardware) ', live: '(live: auto-discovery) ', config: '' }[mode];
console.log(`RF Ranger ${label}on http://localhost:${config.port}`);
if (mode !== 'live') console.log(`  ${config.receivers.length} receivers, ${config.chargers.length} chargers, ${config.slots.length} slots`);
if (!existsSync(webDir)) console.log(`  Web UI not built at ${webDir} (cd web && npm run build), or use the Vite dev server.`);

let stopping = false;
async function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nStopping: switching receiver metering off…');
  liveManager?.stop();
  server.close();
  await runtime.stop();
  await stopDemo?.();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
