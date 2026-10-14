/**
 * RF Ranger server.
 *
 *   npm start -- --config rf-ranger.config.json
 *   npm start -- --demo
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './server/config.js';
import { startDemo } from './server/demo.js';
import { startHttp } from './server/http.js';
import { Runtime } from './server/runtime.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    demo: { type: 'boolean', default: false },
    port: { type: 'string', short: 'p' },
    web: { type: 'string' },
  },
});

const port = values.port ? Number(values.port) : 8058;
let stopDemo: (() => Promise<void>) | undefined;

let config;
if (values.demo) {
  const demo = await startDemo(port);
  config = demo.config;
  stopDemo = demo.stop;
} else {
  const path = resolve(values.config ?? 'rf-ranger.config.json');
  if (!existsSync(path)) {
    console.error(`No config at ${path}. Pass --config <file>, or --demo to try it with simulated hardware.`);
    process.exit(1);
  }
  config = loadConfig(path);
  if (values.port) config.port = port;
}

const webDir = values.web ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const runtime = new Runtime(config, values.demo);
runtime.start();
const server = await startHttp(runtime, { port: config.port, webDir, photosDir: config.photosDir });

console.log(`RF Ranger ${values.demo ? '(DEMO — simulated hardware) ' : ''}on http://localhost:${config.port}`);
console.log(`  ${config.receivers.length} receivers, ${config.chargers.length} chargers, ${config.slots.length} slots`);
if (!existsSync(webDir)) console.log(`  Web UI not built at ${webDir} (cd web && npm run build), or use the Vite dev server.`);

let stopping = false;
async function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nStopping: switching receiver metering off…');
  server.close();
  await runtime.stop();
  await stopDemo?.();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
