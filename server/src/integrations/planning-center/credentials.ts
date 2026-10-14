/**
 * Planning Center credentials are per user, never part of a show config:
 * configs get copied between machines and shared, tokens shouldn't be.
 *
 * Looked up in order:
 *   1. PCO_APP_ID and PCO_SECRET environment variables
 *   2. ~/.rf-ranger/planning-center.json  ({ "appId": "...", "secret": "..." })
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PcoCredentials } from './client.js';

export function credentialsPath(home = homedir()): string {
  return join(home, '.rf-ranger', 'planning-center.json');
}

export function loadCredentials(env: NodeJS.ProcessEnv = process.env, path = credentialsPath()): (PcoCredentials & { source: string }) | undefined {
  if (env.PCO_APP_ID && env.PCO_SECRET) return { appId: env.PCO_APP_ID, secret: env.PCO_SECRET, source: 'environment' };
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PcoCredentials>;
  if (!raw.appId || !raw.secret) throw new Error(`${path} needs both "appId" and "secret"`);
  return { appId: raw.appId, secret: raw.secret, source: path };
}

export function saveCredentials(c: PcoCredentials, path = credentialsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ appId: c.appId, secret: c.secret }, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // no-op on Windows, where the home directory is already per-user
  } catch {
    // best effort
  }
}
