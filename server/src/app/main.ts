/**
 * Desktop app entry point (the packaged macOS app, see packaging/macos).
 *
 * Double-clicking the app runs the *launcher*: if RF Ranger is already
 * running it just opens the browser; otherwise it starts the server as a
 * detached background process, waits for it to answer, opens the browser and
 * exits. The launcher never lingers, so the app never sits in the Dock
 * unresponsive, and a second double-click always brings the UI back.
 * Quit is a button on the launch screen (this computer only).
 *
 *   rf-ranger            launcher
 *   rf-ranger --serve    the server itself (started by the launcher)
 *
 * Files:
 *   macOS    ~/Library/Application Support/RF Ranger/   rf-ranger.config.json (optional), photos, server.json
 *            ~/Library/Logs/RF Ranger/rf-ranger.log
 *   Windows  %APPDATA%\RF Ranger\  (logs in logs\)
 *
 * With no rf-ranger.config.json, the app runs in live mode: it discovers
 * Shure devices and names slots from channel names.
 */
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { format } from 'node:util';
import { startRfRanger, type Running } from '../server/start.js';
import { VERSION } from '../version.js';

const APP_NAME = 'RF Ranger';
const FIRST_PORT = 8058;
const PORT_TRIES = 10;
const START_TIMEOUT_MS = 20_000;

const isMac = process.platform === 'darwin';
const supportDir = isMac
  ? join(homedir(), 'Library', 'Application Support', APP_NAME)
  : process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_NAME)
    : join(homedir(), '.rf-ranger');
const logDir = isMac ? join(homedir(), 'Library', 'Logs', APP_NAME) : join(supportDir, 'logs');
const logFile = join(logDir, 'rf-ranger.log');
const stateFile = join(supportDir, 'server.json');
const configFile = join(supportDir, 'rf-ranger.config.json');

interface State {
  pid: number;
  port: number;
  startedAt: string;
}

/** The built web UI: inside the .app bundle, next to the binary, or an override. */
function webDir(): string {
  if (process.env.RF_RANGER_WEB) return process.env.RF_RANGER_WEB;
  const here = dirname(process.execPath);
  const bundled = resolve(here, '..', 'Resources', 'web');
  return existsSync(bundled) ? bundled : resolve(here, 'web');
}

// ---- launcher ---------------------------------------------------------------

async function launch(): Promise<void> {
  const running = await findRunning();
  if (running && running.version === VERSION) {
    openBrowser(running.port);
    return;
  }
  if (running) {
    // A different version is still running, typically the one this app was
    // just installed over. Its web files on disk are now ours, so leaving it
    // up would serve this version's screens from the old server. Replace it.
    if (!(await replaceRunning(running))) {
      await alert(
        `An older ${APP_NAME} is still running`,
        `RF Ranger ${running.version ?? '(older version)'} didn't quit. Quit it from its launch screen, then open ${APP_NAME} again.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Inside a single-executable app the binary *is* the program; under plain
  // Node (development) the script path has to be passed again.
  const args = isSingleExecutable() ? ['--serve'] : [process.argv[1]!, '--serve'];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: process.env });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const up = await findRunning();
    if (up) {
      openBrowser(up.port);
      return;
    }
  }
  await alert(`${APP_NAME} didn't start`, `Details are in the log:\n${logFile}`);
  process.exitCode = 1;
}

/**
 * The server recorded in server.json, if it is actually answering as RF
 * Ranger, with the version it reports (versions before 0.1.3 report none).
 */
async function findRunning(): Promise<(State & { version?: string }) | undefined> {
  let state: State;
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8')) as State;
  } catch {
    return undefined;
  }
  const snapshot = await getJson(`http://127.0.0.1:${state.port}/api/snapshot`, 1_500);
  if (!snapshot || typeof snapshot !== 'object' || !('slots' in snapshot)) return undefined;
  const version = (snapshot as { version?: unknown }).version;
  return { ...state, version: typeof version === 'string' ? version : undefined };
}

/** Ask a running server to quit (it switches metering off first) and wait until it has gone. */
async function replaceRunning(old: State & { version?: string }): Promise<boolean> {
  console.log(`Replacing RF Ranger ${old.version ?? '(older version)'} on port ${old.port} (pid ${old.pid}) with ${VERSION}.`);
  await postJson(`http://127.0.0.1:${old.port}/api/app/quit`, 3_000);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(250);
    if (!(await findRunning())) return true;
  }
  return false;
}

function postJson(url: string, timeoutMs: number): Promise<number | undefined> {
  return new Promise((done) => {
    const req = http.request(url, { method: 'POST', timeout: timeoutMs, headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(undefined));
    req.end('{}');
  });
}

function getJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((done) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        try {
          done(res.statusCode === 200 ? JSON.parse(body) : undefined);
        } catch {
          done(undefined);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(undefined));
  });
}

function openBrowser(port: number): void {
  if (process.env.RF_RANGER_NO_BROWSER) return;
  const url = `http://localhost:${port}`;
  if (isMac) execFile('/usr/bin/open', [url]);
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url]);
  else execFile('xdg-open', [url]);
}

function alert(title: string, message: string): Promise<void> {
  console.error(`${title}\n${message}`);
  if (!isMac || process.env.RF_RANGER_NO_BROWSER) return Promise.resolve();
  const q = (s: string) => JSON.stringify(s); // AppleScript string literals use the same escaping
  return new Promise((done) => {
    execFile('/usr/bin/osascript', ['-e', `display alert ${q(title)} message ${q(message)} as critical`], () => done());
  });
}

// ---- server -----------------------------------------------------------------

async function serve(): Promise<void> {
  mkdirSync(supportDir, { recursive: true });
  logToFile();
  console.log(`\n=== ${APP_NAME} ${VERSION} starting ${new Date().toISOString()} (pid ${process.pid}) ===`);

  const already = await findRunning();
  if (already && already.pid !== process.pid) {
    console.log(`Already running on port ${already.port} (pid ${already.pid}); exiting.`);
    return;
  }

  const useConfig = existsSync(configFile);
  console.log(useConfig ? `Using ${configFile}` : `No ${configFile}; live mode (auto-discovery).`);

  let running: Running | undefined;
  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping (${why}): switching receiver metering off…`);
    rmSync(stateFile, { force: true });
    await running?.stop();
    console.log('Stopped.');
    process.exit(0);
  };

  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_TRIES && !running; port++) {
    try {
      running = await startRfRanger({
        mode: useConfig ? 'config' : 'live',
        // A config file's own port is honoured; otherwise take the first free one.
        port: useConfig && port === FIRST_PORT ? undefined : port,
        configPath: configFile,
        discover: true,
        webDir: webDir(),
        app: { onQuit: () => void shutdown('quit from the UI') },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      console.log(`Port ${port} is in use; trying the next one.`);
    }
  }
  if (!running) throw new Error(`No free port between ${FIRST_PORT} and ${FIRST_PORT + PORT_TRIES - 1}`);

  const state: State = { pid: process.pid, port: running.port, startedAt: new Date().toISOString() };
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/** There's no terminal behind the app, so everything goes to a log file. */
function logToFile(): void {
  mkdirSync(logDir, { recursive: true });
  try {
    if (statSync(logFile).size > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
  } catch {
    // no log yet
  }
  const write = (args: unknown[]) => {
    try {
      appendFileSync(logFile, format(...args) + '\n');
    } catch {
      // never let logging take the server down
    }
  };
  console.log = (...args: unknown[]) => write(args);
  console.error = (...args: unknown[]) => write(args);
  process.on('uncaughtException', (err) => {
    write([`Uncaught: ${err.stack ?? err}`]);
    rmSync(stateFile, { force: true });
    process.exit(1);
  });
}

// ---- helpers ----------------------------------------------------------------

function isSingleExecutable(): boolean {
  try {
    return (process as unknown as { getBuiltinModule?: (id: string) => { isSea?: () => boolean } | undefined })
      .getBuiltinModule?.('node:sea')?.isSea?.() ?? false;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const main = process.argv.includes('--serve') ? serve : launch;
main().catch((err: Error) => {
  console.error(err.stack ?? String(err));
  void alert(`${APP_NAME} couldn't start`, `${err.message}\n\nLog: ${logFile}`).then(() => process.exit(1));
});
