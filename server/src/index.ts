/**
 * RF Ranger server.
 *
 *   npm start -- --config rf-ranger.config.json     configured show
 *   npm run live                                    find Shure devices on the network
 *   npm run live -- --receiver 10.0.1.20            ...plus/or devices by address
 *   npm run demo                                    simulated hardware
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseTarget } from './server/live.js';
import type { RunMode } from './server/snapshot.js';
import { startRfRanger, type Running } from './server/start.js';

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

const targets = [
  ...(values.receiver ?? []).map((s) => parseTarget(s)),
  ...(values.charger ?? []).map((s) => parseTarget(s, true)),
];
const live = values.live || targets.length > 0;
const mode: RunMode = values.demo ? 'demo' : live ? 'live' : 'config';
const configPath = resolve(values.config ?? 'rf-ranger.config.json');

let running: Running;
try {
  running = await startRfRanger({
    mode,
    port: values.port ? Number(values.port) : undefined,
    configPath,
    targets,
    discover: !values['no-discover'],
    webDir: values.web ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
  });
} catch (err) {
  console.error((err as Error).message);
  if (mode === 'config') {
    console.error('  npm run live      find Shure devices on the network (no config needed)');
    console.error('  npm run demo      try it with simulated hardware');
  }
  process.exit(1);
}

let stopping = false;
async function shutdown() {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('\nStopping: switching receiver metering off…');
  await running.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
