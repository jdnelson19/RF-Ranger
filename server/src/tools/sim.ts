/**
 * Run a simulated Shure receiver so the probe and UI can be exercised without hardware.
 *
 *   npm run sim -- <ulxd|axd|slxd|psm1000> [--port 2202, or 2201 for psm1000]
 *
 * Every 10 s one channel's transmitter toggles off/on and battery drifts down.
 */
import { parseArgs } from 'node:util';
import { SHURE_FAMILIES, type ShureFamilyId } from '../adapters/shure/families.js';
import { ShureSim } from '../sim/shure-sim.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string' } } });
const family = (positionals[0] ?? 'ulxd') as ShureFamilyId;

const sim = new ShureSim({
  family,
  fragment: true,
  channels: [
    { name: 'Lead Vox', batteryBars: 5, batteryPercent: 92, runtimeMin: 410, txDeviceId: 'LeadVox' },
    { name: 'BGV 1', batteryBars: 3, batteryPercent: 45, runtimeMin: 140 },
    { name: 'Pastor', batteryBars: 4, batteryPercent: 70, runtimeMin: 300, txModel: family === 'ulxd' ? 'ULXD1' : undefined },
    { name: 'Spare', txOn: false },
  ].slice(0, family === 'slxd' || family === 'psm1000' ? 2 : 4),
});

const port = await sim.listen(values.port ? Number(values.port) : SHURE_FAMILIES[family].defaultPort, '0.0.0.0');
console.log(`Simulated ${sim.model} listening on port ${port}. Ctrl+C to stop.`);

let tick = 0;
setInterval(() => {
  tick++;
  const ch = (tick % sim.channels.length) + 1;
  const cur = sim.channels[ch - 1]!;
  sim.update(ch, {
    txOn: ch === 4 ? !cur.txOn : cur.txOn,
    batteryPercent: cur.batteryPercent !== undefined ? Math.max(0, cur.batteryPercent - 3) : undefined,
  });
}, 10_000);

process.on('SIGINT', async () => {
  await sim.close();
  process.exit(0);
});
