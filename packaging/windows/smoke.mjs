// Smoke test for a built rf-ranger.exe: proves the bundled app (not bare Node)
// runs inside it, without the exe opening a network port.
//
//   node smoke.mjs <rf-ranger.exe>
//
// A stand-in "RF Ranger" answers on 127.0.0.1 and is recorded in server.json
// under a scratch APPDATA. `rf-ranger.exe --quit` must find it, ask it to quit
// (POST /api/app/quit) and then exit 0 once it has gone.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
const appData = mkdtempSync(join(tmpdir(), 'rf-ranger-smoke-'));
let quitAsked = false;

const fake = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/app/quit') {
    quitAsked = true;
    res.end('{}');
    setTimeout(() => fake.close(), 100); // "quit": stop answering
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ slots: [], version: 'smoke' }));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;
mkdirSync(join(appData, 'RF Ranger'), { recursive: true });
writeFileSync(join(appData, 'RF Ranger', 'server.json'), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));

const child = spawn(exe, ['--quit'], { env: { ...process.env, APPDATA: appData, RF_RANGER_NO_BROWSER: '1' }, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); fail('rf-ranger.exe --quit did not finish within 30 s'); }, 30_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  if (!quitAsked) fail(`rf-ranger.exe exited ${code} without asking the running server to quit: the app blob didn't run`);
  if (code !== 0) fail(`rf-ranger.exe --quit exited ${code}`);
  console.log('Smoke test passed: the exe ran RF Ranger and stopped a running server.');
  process.exit(0);
});

function fail(msg) {
  console.error(`Smoke test failed: ${msg}`);
  process.exit(1);
}
