/**
 * /api/pco: connect and configure Planning Center from the app. Like the
 * Device Inspector, it answers only the computer running RF Ranger (it
 * handles a token that is as good as a password), and changes must be JSON
 * POSTs, which other websites can't send without a preflight we refuse.
 *
 *   GET  /api/pco[?check=1]       status (never includes the secret); check=1 re-tests the token
 *   GET  /api/pco/service-types   service types in the linked account
 *   GET  /api/pco/upcoming[?type=<id>]  a service type's next plan, with a head count
 *   POST /api/pco/connect         { appId, secret }
 *   POST /api/pco/service-type    { id }
 *   POST /api/pco/disconnect      {}
 *
 * Mic assignments, per service (see core/mic-roster.ts):
 *   GET  /api/pco/teams?type=<id>        a service type's teams and positions
 *   GET  /api/pco/team-people?team=<id>  a team's members, for mic preferences
 *   GET  /api/pco/mics                   { services, roster, auto }
 *   POST /api/pco/mics/services/add      { serviceTypeId, name }
 *   POST /api/pco/mics/services/remove   { serviceId }
 *   POST /api/pco/mics/rules             { serviceId, rules }
 *   POST /api/pco/mics/auto              { serviceId, rule } | { serviceId, off: true }
 *   POST /api/pco/mics/sync              { serviceId }  apply its rules to its upcoming plan
 *   POST /api/pco/mics/assign            { mic, personId } | { mic, name, role? } | { mic, clear: true }
 *   POST /api/pco/mics/clear             {}  empty every mic
 */
import type http from 'node:http';
import { LinkError, type PlanningCenterLink } from '../integrations/planning-center/link.js';
import { isLocalRequest, readJson } from './inspector.js';
import { syncService, type AutoSync } from './auto-sync.js';
import { RosterError, type MicRosterStore } from './mic-roster-store.js';

export async function handlePco(link: PlanningCenterLink, mics: MicRosterStore | undefined, autoSync: AutoSync | undefined, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!isLocalRequest(req)) {
    json(403, { error: 'Planning Center settings are only available on the computer running RF Ranger.' });
    return;
  }

  const route = url.pathname.replace(/^\/api\/pco\/?/, '');
  const type = url.searchParams.get('type') ?? undefined;
  try {
    if (req.method === 'GET') {
      if (route === '') return json(200, url.searchParams.get('check') === '1' ? await link.refresh() : link.status());
      if (route === 'service-types') return json(200, { serviceTypes: await link.serviceTypes() });
      if (route === 'upcoming') return json(200, await link.upcoming(type));
      if (route === 'teams') return json(200, { teams: await link.teams(type) });
      if (route === 'team-people') return json(200, { people: await link.teamPeople(url.searchParams.get('team') ?? '') });
      if (route === 'mics' && mics) return json(200, { services: mics.services(), roster: mics.roster(), auto: autoSync?.info() ?? {} });
    } else if (req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'Expected JSON' });
      const body = (await readJson(req)) as Record<string, unknown>;
      if (route === 'connect') return json(200, await link.connect(String(body.appId ?? ''), String(body.secret ?? '')));
      if (route === 'service-type') return json(200, await link.setServiceType(String(body.id ?? '')));
      if (route === 'disconnect') return json(200, link.disconnect());
      if (mics && route.startsWith('mics/')) {
        const done = () => json(200, { services: mics.services(), roster: mics.roster(), auto: autoSync?.info() ?? {} });
        const serviceId = String(body.serviceId ?? '');
        if (route === 'mics/services/add') {
          // Only service types in this account; the name comes from Planning Center, not the request.
          const st = (await link.serviceTypes()).find((t) => t.id === String(body.serviceTypeId ?? ''));
          if (!st) throw new RosterError('That service type is not in this Planning Center account.');
          mics.addService({ serviceTypeId: st.id, name: st.name });
          return done();
        }
        if (route === 'mics/services/remove') { mics.removeService(serviceId); return done(); }
        if (route === 'mics/rules') { mics.setRules(serviceId, body.rules); return done(); }
        if (route === 'mics/clear') { mics.clear(); return done(); }
        if (route === 'mics/auto') {
          mics.setAutoSync(serviceId, body.off === true ? null : body.rule);
          await autoSync?.tick(); // so the reply already says when it will run
          return done();
        }
        if (route === 'mics/assign') {
          mics.assign(String(body.mic ?? ''), body.clear === true ? null : { personId: body.personId, name: body.name, role: body.role });
          return done();
        }
        if (route === 'mics/sync') {
          if (!(await syncService(link, mics, serviceId))) throw new LinkError('There’s no upcoming plan for this service to sync from.');
          return done();
        }
      }
    }
    json(404, { error: 'Not found' });
  } catch (err) {
    // LinkError and RosterError messages are written for people; anything else is unexpected.
    if (err instanceof LinkError || err instanceof RosterError) return json(400, { error: err.message });
    json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
