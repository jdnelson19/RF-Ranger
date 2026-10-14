/**
 * Hardware validation tool: connect to one Shure receiver, log every frame to
 * a file, and print the normalised telemetry once a second so it can be
 * compared with the receiver's front panel / Wireless Workbench.
 *
 *   npm run probe -- <ulxd|axd|slxd> <host> [--port 2202] [--channels 4] [--meter 250]
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SHURE_FAMILIES, type ShureFamilyId } from '../adapters/shure/families.js';
import { ShureReceiver } from '../adapters/shure/receiver.js';
import type { ChannelTelemetry } from '../core/model.js';
import type { Reading } from '../core/reading.js';
import { readiness, txPresent } from '../core/readiness.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    channels: { type: 'string' },
    meter: { type: 'string' },
  },
});

const [family, host] = positionals;
if (!family || !host || !(family in SHURE_FAMILIES)) {
  console.error('usage: npm run probe -- <ulxd|axd|slxd> <host> [--port 2202] [--channels N] [--meter ms]');
  process.exit(1);
}

mkdirSync('logs', { recursive: true });
const logPath = join('logs', `probe-${family}-${host.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const log = createWriteStream(logPath);

const rx = new ShureReceiver({
  id: host,
  host,
  family: family as ShureFamilyId,
  port: values.port ? Number(values.port) : undefined,
  channels: values.channels ? Number(values.channels) : undefined,
  meterRateMs: values.meter ? Number(values.meter) : undefined,
});

rx.on('wire', (dir, frame) => log.write(`${new Date().toISOString()} ${dir === 'in' ? '<-' : '->'} ${frame}\n`));
rx.on('status', (s) => log.write(`${new Date().toISOString()} ** ${s.state}${s.lastError ? ` (${s.lastError})` : ''}\n`));

function show<T>(r: Reading<T>, fmt: (v: T) => string = String): string {
  switch (r.state) {
    case 'ok': return fmt(r.value);
    case 'absent': return '—';
    case 'unsupported': return 'n/a';
    case 'unknown': return '…';
  }
}

function row(ch: number, t: ChannelTelemetry, now: number) {
  const ready = readiness({ assigned: true, connection: rx.status, telemetry: t, now });
  return {
    ch,
    name: show(t.name),
    'MHz': show(t.frequencyKhz, (v) => (v / 1000).toFixed(3)),
    tx: txPresent(t) ? show(t.txModel) : 'off',
    'tx id': show(t.txDeviceId),
    bars: show(t.batteryBars),
    '%': show(t.batteryPercent),
    'min': show(t.batteryRuntimeMin),
    'RF dBm': show(t.rfDbm, (v) => v.join('/')),
    ant: show(t.antennas),
    'audio dBFS': show(t.audioRmsDbfs),
    qual: show(t.linkQuality),
    'rx mute': show(t.rxMuted, (v) => (v ? 'MUTED' : 'off')),
    readiness: ready.label + (ready.reason ? ` (${ready.reason})` : ''),
  };
}

const timer = setInterval(() => {
  const now = Date.now();
  const s = rx.status;
  console.clear();
  console.log(`${SHURE_FAMILIES[family as ShureFamilyId].label} @ ${host}  —  ${s.state.toUpperCase()}${s.lastError && s.state !== 'connected' ? `  (${s.lastError})` : ''}`);
  console.log(`model: ${rx.info.model ?? '?'}  device id: ${rx.info.deviceId ?? '?'}  firmware: ${rx.info.firmware ?? '?'}`);
  console.log(`raw log: ${logPath}    legend: — = device says unavailable, n/a = not supported, … = not received yet\n`);
  console.table([...rx.channels].map(([ch, st]) => row(ch, st.telemetry, now)));
  console.log('\nCtrl+C to stop (metering is switched off on exit).');
}, 1_000);

let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  clearInterval(timer);
  await rx.stop();
  log.end(() => {
    console.log(`\nSaved raw log to ${logPath}`);
    process.exit(0);
  });
});

rx.start();
