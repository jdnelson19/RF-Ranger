/**
 * Run a simulated receiver so the probe and UI can be exercised without hardware.
 *
 *   npm run sim -- <ulxd|axd|slxd|psm1000|ewdx|d6000> [--port N]
 *
 * Default ports: 2202 (Shure receivers), 2201 (PSM 1000), 45 (Sennheiser SSC;
 * binding below 1024 may need admin rights, so pass e.g. --port 4545).
 * Every 10 s one channel's transmitter toggles off/on and battery drifts down.
 */
import { parseArgs } from 'node:util';
import { isSennheiser, type DeviceFamilyId } from '../adapters/families.js';
import { SSC_PORT } from '../adapters/sennheiser/ssc.js';
import { SHURE_FAMILIES } from '../adapters/shure/families.js';
import { SennheiserSim } from '../sim/sennheiser-sim.js';
import { ShureSim } from '../sim/shure-sim.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string' } } });
const family = (positionals[0] ?? 'ulxd') as DeviceFamilyId;

let close: () => Promise<void>;
let drift: () => void;

if (isSennheiser(family)) {
  const sim = new SennheiserSim({
    family,
    channels: [
      { name: 'Lead Vox', batteryPercent: 92, batteryState: '100%', runtimeMin: 410 },
      { name: 'BGV 1', batteryPercent: 45, batteryState: '70%', runtimeMin: 140 },
      { name: 'Pastor', batteryPercent: 70, batteryState: '70%', runtimeMin: 300, primaryCell: true },
      { name: 'Spare', txOn: false },
    ].slice(0, family === 'd6000' ? 2 : 4),
  });
  const port = await sim.listen(values.port ? Number(values.port) : SSC_PORT, '0.0.0.0');
  console.log(`Simulated Sennheiser ${sim.product} answering SSC on UDP port ${port}. Ctrl+C to stop.`);
  close = () => sim.close();
  let tick = 0;
  drift = () => {
    tick++;
    const ch = (tick % sim.channels.length) + 1;
    const cur = sim.channels[ch - 1]!;
    sim.update(ch, {
      txOn: ch === sim.channels.length ? !cur.txOn : cur.txOn,
      batteryPercent: Math.max(0, cur.batteryPercent - 3),
      rfDbm: -50 - Math.round(Math.random() * 30),
      audioDbfs: -40 + Math.round(Math.random() * 25),
    });
  };
} else {
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
  close = () => sim.close();
  let tick = 0;
  drift = () => {
    tick++;
    const ch = (tick % sim.channels.length) + 1;
    const cur = sim.channels[ch - 1]!;
    sim.update(ch, {
      txOn: ch === 4 ? !cur.txOn : cur.txOn,
      batteryPercent: cur.batteryPercent !== undefined ? Math.max(0, cur.batteryPercent - 3) : undefined,
    });
  };
}

setInterval(drift, 10_000);

process.on('SIGINT', async () => {
  await close();
  process.exit(0);
});
