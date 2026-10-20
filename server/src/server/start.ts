import { existsSync } from 'node:fs';
import type http from 'node:http';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PlanningCenterLink } from '../integrations/planning-center/link.js';
import { loadConfig, normalizeConfig, type Config } from './config.js';
import { loadSettings } from '../integrations/planning-center/credentials.js';
import { AutoSync } from './auto-sync.js';
import { LiveWatcher } from './live-watch.js';
import { UpdateCheck } from './update-check.js';
import { VERSION } from '../version.js';
import { MicRosterStore, micRosterPath } from './mic-roster-store.js';
import { PresetStore, presetsPath } from './presets.js';
import { demoLive, startDemo } from './demo.js';
import { startHttp } from './http.js';
import { Inspector } from './inspector.js';
import { KnownDevices, knownDevicesPath } from './known-devices.js';
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
  /** Defaults to this user's saved link (see integrations/planning-center). */
  planningCenter?: PlanningCenterLink;
  /** Defaults to ~/.rf-ranger/show-presets.json; demo mode keeps presets in memory. */
  presets?: PresetStore;
  /** Defaults to ~/.rf-ranger/mic-assignments.json; demo mode keeps them in memory. */
  micRoster?: MicRosterStore;
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
  const forgetDevice: { current?: (host: string) => boolean } = {};
  const addDevice: { current?: (spec: string) => string } = {};
  const inspector = new Inspector(runtime);
  const planningCenter = opts.planningCenter ?? new PlanningCenterLink({ log: (m) => log(`  ${m}`) });
  const presets = opts.presets ?? new PresetStore(opts.mode === 'demo' ? undefined : presetsPath());
  runtime.presets = () => presets.list();
  runtime.pickupPreset = () => presets.pickupPreset();
  presets.on('change', () => runtime.emit('dirty'));
  // Mic rules saved before services existed belong to the service type chosen in the Planning Center settings.
  const pcoSettings = loadSettings();
  const legacyType = pcoSettings.serviceTypeId ? { id: pcoSettings.serviceTypeId, name: pcoSettings.serviceTypeName ?? pcoSettings.serviceTypeId } : undefined;
  const micRoster = opts.micRoster ?? new MicRosterStore(opts.mode === 'demo' ? undefined : micRosterPath(), Date.now, legacyType);
  runtime.roster = () => micRoster.roster();
  micRoster.on('change', () => runtime.emit('dirty'));
  const liveWatch = new LiveWatcher(planningCenter, micRoster, { log: (m) => log(`  ${m}`) });
  // Demo mode plays a made-up running order instead of a real Services Live.
  runtime.live = opts.mode === 'demo' ? () => demoLive() : () => liveWatch.live();
  liveWatch.on('change', () => runtime.emit('dirty'));
  const autoSync = new AutoSync(planningCenter, micRoster, { log: (m) => log(`  ${m}`) });
  let server: http.Server;
  try {
    server = await startHttp(runtime, {
      port: config.port,
      webDir: opts.webDir,
      photosDir: config.photosDir,
      inspector,
      planningCenter,
      presets,
      micRoster,
      autoSync,
      forgetDevice: (host) => forgetDevice.current?.(host) ?? false,
      addDevice: (spec) => {
        if (!addDevice.current) throw new Error('Devices can be added in live mode only.');
        return addDevice.current(spec);
      },
      onQuit: opts.app?.onQuit,
    });
  } catch (err) {
    await stopDemo?.();
    throw err;
  }
  runtime.app = opts.app !== undefined;
  runtime.start();
  autoSync.start();
  if (opts.mode !== 'demo') liveWatch.start();
  const updates = new UpdateCheck(VERSION, { log: (m) => log(`  ${m}`) });
  runtime.update = () => updates.notice();
  if (!process.env.RF_RANGER_NO_UPDATE_CHECK && opts.mode !== 'demo') updates.start();
  // Check a saved Planning Center link in the background; never delays startup.
  if (planningCenter.status().configured) {
    // A failure is logged by the link itself.
    void planningCenter.refresh().then((s) => s.connected && log(`  Planning Center: ${s.organization?.name}`));
  }

  let liveManager: LiveManager | undefined;
  // Set below in live mode; the HTTP server is already up, so it reads this lazily.
  forgetDevice.current = undefined;
  if (opts.mode === 'live') {
    const known = new KnownDevices(knownDevicesPath());
    runtime.rememberedName = (id, ch) => known.name(id, ch);
    liveManager = new LiveManager(runtime, {
      known,
      discover: opts.discover ?? true,
      targets: opts.targets ?? [],
      log: (m) => log(`  ${m}`),
    });
    await liveManager.start();
    const manager = liveManager;
    forgetDevice.current = (host) => manager.forget(host);
    addDevice.current = (spec) => manager.add(spec);
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
      autoSync.stop();
      liveWatch.stop();
      updates.stop();
      await inspector.closeAll();
      server.close();
      await runtime.stop();
      await stopDemo?.();
    },
  };
}
