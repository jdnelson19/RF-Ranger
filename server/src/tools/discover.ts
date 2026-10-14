/**
 * List Shure devices on the network and what they are.
 *
 *   npm run discover                    listen for 30 s
 *   npm run discover -- --seconds 90
 *   npm run discover -- 10.0.1.20 10.0.1.21    also identify these addresses
 *
 * Every raw announcement is saved to logs/ so the discovery format can be
 * checked against real hardware.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ShureDiscovery } from '../adapters/shure/discovery.js';
import { identifyShure, type Identity } from '../adapters/shure/identify.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seconds: { type: 'string', default: '30' } },
});

mkdirSync('logs', { recursive: true });
const logPath = join('logs', `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const log = createWriteStream(logPath);

const results = new Map<string, Identity | 'identifying'>();
const identify = async (ip: string) => {
  if (results.has(ip)) return;
  results.set(ip, 'identifying');
  const id = await identifyShure(ip);
  results.set(ip, id);
  log.write(`${new Date().toISOString()} identify ${ip} ${JSON.stringify(id)}\n`);
  print();
};

function print() {
  console.clear();
  console.log(`Shure discovery: listening for ${values.seconds}s. Raw log: ${logPath}\n`);
  if (!results.size) console.log('Nothing yet… (devices announce every so often; give it time)');
  const rows = [...results.entries()].map(([ip, r]) =>
    r === 'identifying'
      ? { address: ip, model: '…', 'device id': '', type: 'identifying', channels: '', status: '' }
      : {
          address: ip,
          model: r.model ?? '?',
          'device id': r.deviceId ?? '',
          type: r.kind ?? '',
          channels: r.channels ?? '',
          status: !r.reachable ? 'no answer on port 2202' : r.unsupported ?? 'supported ✓',
        },
  );
  if (rows.length) console.table(rows);
}

const d = new ShureDiscovery();
d.on('packet', (ip, text) => log.write(`${new Date().toISOString()} packet ${ip} ${text}\n`));
d.on('found', (s) => void identify(s.ip));
d.on('error', (err) => console.error(`Discovery error: ${err.message}`));
const ok = await d.start();
if (!ok) console.error('Could not listen for discovery packets (port 8427 may be in use). Identifying given addresses only.');
for (const ip of positionals) void identify(ip);
print();

setTimeout(() => {
  d.stop();
  print();
  console.log(`\nDone. ${results.size} device(s). Raw log saved to ${logPath}`);
  log.end(() => process.exit(0));
}, Number(values.seconds) * 1000);
