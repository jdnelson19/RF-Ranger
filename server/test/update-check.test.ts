import { describe, expect, it } from 'vitest';
import { UpdateCheck, isNewer } from '../src/server/update-check.js';

const feed = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
const latest = {
  version: '0.2.0',
  notesUrl: 'https://github.com/x/releases/tag/v0.2.0',
  mac: { url: 'https://dl/RF-Ranger-0.2.0.dmg' },
  windows: { url: 'https://dl/RF-Ranger-0.2.0-Windows-Setup.exe' },
};

describe('update check', () => {
  it('compares versions numerically', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.8', '0.1.8')).toBe(false);
    expect(isNewer('0.1.7', '0.1.8')).toBe(false);
    expect(isNewer('garbage', '0.1.8')).toBe(false);
  });

  it("offers this computer's download when a newer version is out", async () => {
    expect(await new UpdateCheck('0.1.8', { fetch: feed(latest), platform: 'win32' }).check())
      .toEqual({ version: '0.2.0', url: 'https://dl/RF-Ranger-0.2.0-Windows-Setup.exe' });
    expect((await new UpdateCheck('0.1.8', { fetch: feed(latest), platform: 'darwin' }).check())?.url).toBe('https://dl/RF-Ranger-0.2.0.dmg');
    expect((await new UpdateCheck('0.1.8', { fetch: feed(latest), platform: 'linux' }).check())?.url).toBe(latest.notesUrl);
  });

  it('says nothing when up to date, or when the check fails', async () => {
    expect(await new UpdateCheck('0.2.0', { fetch: feed(latest) }).check()).toBeUndefined();
    expect(await new UpdateCheck('0.1.8', { fetch: feed({}, false) }).check()).toBeUndefined();
    const offline = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    expect(await new UpdateCheck('0.1.8', { fetch: offline }).check()).toBeUndefined();
  });
});
