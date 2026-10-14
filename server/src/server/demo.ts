import net from 'node:net';
import { ChargerSim } from '../sim/charger-sim.js';
import { ShureSim } from '../sim/shure-sim.js';
import { normalizeConfig, type Config } from './config.js';

/**
 * Demo mode: simulated receivers and a charger on local ports, plus a
 * fictional team. The UI marks everything as DEMO so it can't be mistaken
 * for live telemetry.
 */
export async function startDemo(port: number): Promise<{ config: Config; stop: () => Promise<void> }> {
  const axd = new ShureSim({
    family: 'axd',
    channels: [
      { name: 'Maya', txModel: 'AD2', txDeviceId: 'LeadVox', batteryBars: 5, batteryPercent: 92, runtimeMin: 412, rfDbm: -52, audioDbfs: -18 },
      { name: 'Jordan', txModel: 'AD2', batteryBars: 3, batteryPercent: 44, runtimeMin: 128, rfDbm: -61, audioDbfs: -24 },
      { name: 'Priya', txOn: false },
      { name: 'Sam', txOn: false },
    ],
  });
  const ulxd = new ShureSim({
    family: 'ulxd',
    channels: [
      { name: 'PASTOR', txModel: 'ULXD1', batteryBars: 5, batteryPercent: 88, runtimeMin: 350, rfDbm: -58, audioDbfs: -26 },
      { name: 'HOST', txOn: false },
      { name: 'AC GTR', txModel: 'ULXD1', batteryBars: 3, rfDbm: -66, audioDbfs: -30 },
      { name: 'VIOLIN', txModel: 'ULXD1', batteryBars: 1, rfDbm: -89, audioDbfs: -40 },
    ],
  });
  const slxd = new ShureSim({
    family: 'slxd',
    channels: [
      { name: 'ANNOUNCE', txModel: 'SLXD2', batteryBars: 5, rfDbm: -55, audioDbfs: -35 },
      { name: 'SPARE', txOn: false },
    ],
  });
  const psm = new ShureSim({
    family: 'psm1000',
    deviceId: 'IEM RACK',
    channels: [
      { name: 'IEM1 Maya', frequencyKhz: 518_125, rfOutputMw: 50 },
      { name: 'IEM2 Eli', frequencyKhz: 519_375, rfOutputMw: 50, rfMuted: true },
    ],
  });
  const charger = new ChargerSim([
    { present: true, chargePercent: 100 },
    { present: true, chargePercent: 64 },
    { present: false, chargePercent: 0 },
    { present: true, chargePercent: 100 },
  ]);

  const [axdPort, ulxdPort, slxdPort, psmPort, chargerPort, deadPort] = await Promise.all([
    axd.listen(),
    ulxd.listen(),
    slxd.listen(),
    psm.listen(),
    charger.listen(),
    unusedPort(),
  ]);

  const config = normalizeConfig({
    port,
    groups: ['Vocals', 'Speakers', 'Band'],
    receivers: [
      { id: 'AD4Q-1', family: 'axd', host: '127.0.0.1', port: axdPort },
      { id: 'ULXD4Q-1', family: 'ulxd', host: '127.0.0.1', port: ulxdPort },
      { id: 'SLXD4D-1', family: 'slxd', host: '127.0.0.1', port: slxdPort },
      { id: 'P10T-1', family: 'psm1000', host: '127.0.0.1', port: psmPort },
      // Deliberately unreachable, to show how an outage looks.
      { id: 'ULXD4D-2', family: 'ulxd', host: '127.0.0.1', port: deadPort, channels: 2 },
    ],
    chargers: [{ id: 'SBC220-A', host: '127.0.0.1', port: chargerPort }],
    slots: [
      { slot: 1, receiver: 'AD4Q-1', channel: 1, label: 'H1', kind: 'handheld', group: 'Vocals',
        assignment: { artist: 'Maya Torres', role: 'Worship Leader', expectedTxId: 'LeadVox' } },
      { slot: 2, receiver: 'AD4Q-1', channel: 2, label: 'H2', kind: 'handheld', group: 'Vocals',
        assignment: { artist: 'Jordan Lee', role: 'Vocals' } },
      { slot: 3, receiver: 'AD4Q-1', channel: 3, label: 'H3', kind: 'handheld', group: 'Vocals',
        assignment: { artist: 'Priya Shah', role: 'Vocals', charger: { id: 'SBC220-A', bay: 1 } } },
      { slot: 4, receiver: 'AD4Q-1', channel: 4, label: 'H4', kind: 'handheld', group: 'Vocals',
        assignment: { artist: 'Sam Okafor', role: 'Vocals', charger: { id: 'SBC220-A', bay: 2 } } },
      { slot: 5, receiver: 'ULXD4Q-1', channel: 1, label: 'BP1', kind: 'bodypack', group: 'Speakers',
        assignment: { artist: 'Daniel Reyes', role: 'Teaching Pastor' } },
      { slot: 6, receiver: 'ULXD4Q-1', channel: 2, label: 'BP2', kind: 'bodypack', group: 'Speakers',
        assignment: { artist: 'Grace Kim', role: 'Host', charger: { id: 'SBC220-A', bay: 3 } } },
      { slot: 7, receiver: 'ULXD4Q-1', channel: 3, label: 'BP3', kind: 'bodypack', group: 'Band',
        assignment: { artist: 'Eli Brooks', role: 'Acoustic Guitar' } },
      { slot: 8, receiver: 'ULXD4Q-1', channel: 4, label: 'BP4', kind: 'bodypack', group: 'Band',
        assignment: { artist: 'Nora Lind', role: 'Violin' } },
      { slot: 9, receiver: 'SLXD4D-1', channel: 1, label: 'H5', kind: 'handheld', group: 'Speakers',
        assignment: { artist: 'Chris Patel', role: 'Announcements' } },
      { slot: 10, receiver: 'SLXD4D-1', channel: 2, label: 'H6', kind: 'handheld', group: 'Speakers' },
      { slot: 11, receiver: 'ULXD4D-2', channel: 1, label: 'BP5', kind: 'bodypack', group: 'Band',
        assignment: { artist: 'Marcus Hill', role: 'Drums' } },
      { slot: 12, receiver: 'ULXD4D-2', channel: 2, label: 'BP6', kind: 'bodypack', group: 'Band' },
      { slot: 13, receiver: 'P10T-1', channel: 1, label: 'IEM1', kind: 'iem', group: 'Vocals',
        assignment: { artist: 'Maya Torres', role: 'Worship Leader' } },
      { slot: 14, receiver: 'P10T-1', channel: 2, label: 'IEM2', kind: 'iem', group: 'Band',
        assignment: { artist: 'Eli Brooks', role: 'Acoustic Guitar' } },
    ],
  });

  // Keep a little motion in the demo: H2's battery slowly drains.
  const toggle = setInterval(() => {
    const ch = axd.channels[1]!;
    axd.update(2, { batteryPercent: Math.max(8, (ch.batteryPercent ?? 50) - 1) });
  }, 15_000);

  return {
    config,
    stop: async () => {
      clearInterval(toggle);
      await Promise.all([axd.close(), ulxd.close(), slxd.close(), psm.close(), charger.close()]);
    },
  };
}

async function unusedPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
