/**
 * /api/pco: connect and configure Planning Center from the app. Like the
 * Device Inspector, it answers only the computer running RF Ranger (it
 * handles a token that is as good as a password), and changes must be JSON
 * POSTs, which other websites can't send without a preflight we refuse.
 *
 *   GET  /api/pco[?check=1]       status (never includes the secret); check=1 re-tests the token
 *   GET  /api/pco/service-types   service types in the linked account
 *   GET  /api/pco/upcoming        the plan RF Ranger would prepare for, with a head count
 *   POST /api/pco/connect         { appId, secret }
 *   POST /api/pco/service-type    { id }
 *   POST /api/pco/disconnect      {}
 */
import type http from 'node:http';
import { LinkError, type PlanningCenterLink } from '../integrations/planning-center/link.js';
import { isLocalRequest, readJson } from './inspector.js';

export async function handlePco(link: PlanningCenterLink, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  if (!isLocalRequest(req)) {
    json(403, { error: 'Planning Center settings are only available on the computer running RF Ranger.' });
    return;
  }

  const route = url.pathname.replace(/^\/api\/pco\/?/, '');
  try {
    if (req.method === 'GET') {
      if (route === '') return json(200, url.searchParams.get('check') === '1' ? await link.refresh() : link.status());
      if (route === 'service-types') return json(200, { serviceTypes: await link.serviceTypes() });
      if (route === 'upcoming') return json(200, await link.upcoming());
    } else if (req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'Expected JSON' });
      const body = (await readJson(req)) as Record<string, unknown>;
      if (route === 'connect') return json(200, await link.connect(String(body.appId ?? ''), String(body.secret ?? '')));
      if (route === 'service-type') return json(200, await link.setServiceType(String(body.id ?? '')));
      if (route === 'disconnect') return json(200, link.disconnect());
    }
    json(404, { error: 'Not found' });
  } catch (err) {
    // LinkError messages are written for people; anything else is unexpected.
    if (err instanceof LinkError) return json(400, { error: err.message });
    json(500, { error: err instanceof Error ? err.message : String(err) });
  }
}
