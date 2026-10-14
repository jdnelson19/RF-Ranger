import { readFileSync } from 'node:fs';

/** The running RF Ranger version: reported in snapshots, device reports and to the app launcher. */
export const VERSION: string = (() => {
  // Set at build time when bundled into the desktop app, where package.json isn't shipped.
  if (process.env.RF_RANGER_VERSION) return process.env.RF_RANGER_VERSION;
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();
