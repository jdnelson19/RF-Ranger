/**
 * Planning Center connection check: store a Personal Access Token for this
 * user, then read service types, the upcoming plan, who is scheduled, and the
 * live timer state. Read-only.
 *
 *   npm run pco -- setup                     store credentials for this user
 *   npm run pco -- types                     list service types
 *   npm run pco -- next <service type>       upcoming plan and scheduled people
 *   npm run pco -- live <service type>       Services Live state of that plan
 *   npm run pco -- watch <service type>      poll live state every 5 s
 *
 * <service type> is a name ("Sunday AM") or an ID.
 */
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { PcoClient, PcoError } from '../integrations/planning-center/client.js';
import { credentialsPath, loadCredentials, saveCredentials } from '../integrations/planning-center/credentials.js';
import {
  liveState,
  planEndsAt,
  scheduledPeople,
  serviceTypes,
  upcomingPlan,
  type LiveState,
} from '../integrations/planning-center/services.js';

const { positionals } = parseArgs({ allowPositionals: true });
const [command, ...rest] = positionals;
const typeArg = rest.join(' ');

const USAGE = 'usage: npm run pco -- <setup | types | next <service type> | live <service type> | watch <service type>>';

async function main(): Promise<void> {
  if (command === 'setup') return setup();
  if (!command || !['types', 'next', 'live', 'watch'].includes(command)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const creds = loadCredentials();
  if (!creds) {
    console.error(`No Planning Center credentials. Run "npm run pco -- setup", or set PCO_APP_ID and PCO_SECRET.`);
    process.exitCode = 1;
    return;
  }
  const client = new PcoClient({ credentials: creds });

  const types = await serviceTypes(client);
  if (command === 'types') {
    console.log(`Credentials: ${creds.source}\n`);
    for (const t of types) console.log(`  ${t.id.padEnd(10)} ${t.name}`);
    return;
  }

  if (!typeArg) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const type = types.find((t) => t.id === typeArg || t.name.toLowerCase() === typeArg.toLowerCase());
  if (!type) {
    console.error(`No service type "${typeArg}". Known: ${types.map((t) => t.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const plan = await upcomingPlan(client, type.id);
  if (!plan) {
    console.log(`${type.name}: no upcoming plans.`);
    return;
  }
  const ends = planEndsAt(plan);
  console.log(`${type.name} · ${plan.dates}${plan.title ? ` · ${plan.title}` : ''}${plan.seriesTitle ? ` (${plan.seriesTitle})` : ''}`);
  console.log(`  plan ${plan.id}; ${plan.times.filter((t) => t.kind === 'service').length} service time(s)${ends ? `, last ends ${new Date(ends).toLocaleString()}` : ''}\n`);

  if (command === 'next') {
    const people = await scheduledPeople(client, type.id, plan.id);
    const rows = people
      .sort((a, b) => a.team.localeCompare(b.team) || a.position.localeCompare(b.position) || a.index - b.index)
      .map((p) => [p.team, `${p.position}${people.filter((q) => q.team === p.team && q.position === p.position).length > 1 ? ` #${p.index}` : ''}`, p.name, p.status, p.photoUrl ? 'photo' : '']);
    const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]!.length), 4));
    for (const r of rows) console.log(`  ${r[0]!.padEnd(w[0]!)}  ${r[1]!.padEnd(w[1]!)}  ${r[2]!.padEnd(w[2]!)}  ${r[3]!.padEnd(11)} ${r[4]}`);
    console.log(`\n  ${people.length} scheduled; ${people.filter((p) => p.status === 'declined').length} declined, ${people.filter((p) => p.status === 'unconfirmed').length} unconfirmed`);
    return;
  }

  printLive(await liveState(client, type.id, plan.id));
  if (command === 'watch') {
    setInterval(() => {
      liveState(client, type.id, plan.id).then(printLive, (err) => console.error(String(err)));
    }, 5_000);
  }
}

function printLive(l: LiveState): void {
  const stamp = new Date().toLocaleTimeString();
  if (l.state !== 'running' || !l.current) {
    console.log(`[${stamp}] ${l.state}${l.next ? ` · first up: ${l.next.title} (${mmss(l.next.lengthSec)})` : ''}`);
    return;
  }
  const remaining = Math.round((Date.parse(l.current.endsAt) - Date.now()) / 1_000);
  const clock = remaining >= 0 ? `${mmss(remaining)} left` : `${mmss(-remaining)} OVER`;
  console.log(`[${stamp}] ${l.current.title} · ${clock} of ${mmss(l.current.lengthSec)}${l.next ? ` · next: ${l.next.title}` : ''}`);
}

function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

async function setup(): Promise<void> {
  console.log('Create a Personal Access Token at https://api.planningcenteronline.com/oauth/applications');
  console.log(`It will be saved for this user only, at ${credentialsPath()}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const appId = (await rl.question('Application ID: ')).trim();
  const secret = (await rl.question('Secret: ')).trim();
  rl.close();
  if (!appId || !secret) {
    console.error('Both are required.');
    process.exitCode = 1;
    return;
  }

  const types = await serviceTypes(new PcoClient({ credentials: { appId, secret } }));
  saveCredentials({ appId, secret });
  console.log(`\nConnected. ${types.length} service type(s): ${types.map((t) => t.name).join(', ')}`);
}

main().catch((err) => {
  console.error(err instanceof PcoError ? err.message : err);
  process.exitCode = 1;
});
