/**
 * Minimal Planning Center API client: HTTP Basic auth with a Personal Access
 * Token, JSON:API documents, pagination and rate-limit backoff. Read-only.
 * See docs/planning-center.md.
 */

export const PCO_API = 'https://api.planningcenteronline.com';

export interface PcoCredentials {
  /** Personal Access Token "Application ID". */
  appId: string;
  /** Personal Access Token "Secret". */
  secret: string;
}

/** One JSON:API resource. */
export interface PcoResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
  relationships?: Record<string, { data: { type: string; id: string } | Array<{ type: string; id: string }> | null }>;
}

export interface PcoDocument<D = PcoResource | PcoResource[]> {
  data: D;
  included?: PcoResource[];
  links?: { next?: string };
  meta?: { total_count?: number; next?: { offset: number } };
}

export type PcoErrorKind = 'auth' | 'forbidden' | 'not-found' | 'rate-limited' | 'network' | 'http';

export class PcoError extends Error {
  constructor(readonly kind: PcoErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = 'PcoError';
  }
}

export interface PcoClientOptions {
  credentials: PcoCredentials;
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Retries after HTTP 429 before giving up. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class PcoClient {
  private readonly auth: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: PcoClientOptions) {
    this.auth = 'Basic ' + Buffer.from(`${opts.credentials.appId}:${opts.credentials.secret}`).toString('base64');
    this.baseUrl = opts.baseUrl ?? PCO_API;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** GET a path (e.g. `/services/v2/service_types`) or an absolute API URL. */
  async get<D = PcoResource | PcoResource[]>(path: string, query: Record<string, string | number> = {}): Promise<PcoDocument<D>> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(url, { headers: { Authorization: this.auth, Accept: 'application/json' } });
      } catch (err) {
        throw new PcoError('network', `Can't reach Planning Center: ${(err as Error).message}`);
      }

      if (res.ok) return (await res.json()) as PcoDocument<D>;

      // Planning Center allows 100 requests per 20 s and says how long to wait.
      if (res.status === 429 && attempt < this.maxRetries) {
        const wait = Number(res.headers.get('Retry-After') ?? 1);
        await this.sleep(Math.max(1, wait) * 1_000);
        continue;
      }
      throw errorFor(res.status, url.pathname);
    }
  }

  /** Every page of a collection, following `links.next`. Included resources are merged. */
  async getAll<A = Record<string, unknown>>(path: string, query: Record<string, string | number> = {}, maxPages = 20): Promise<PcoDocument<PcoResource<A>[]>> {
    const data: PcoResource<A>[] = [];
    const included: PcoResource[] = [];
    let doc = await this.get<PcoResource<A>[]>(path, { per_page: 100, ...query });
    for (let page = 1; ; page++) {
      data.push(...doc.data);
      included.push(...(doc.included ?? []));
      if (!doc.links?.next || page >= maxPages) break;
      doc = await this.get<PcoResource<A>[]>(doc.links.next);
    }
    return { data, included };
  }
}

function errorFor(status: number, path: string): PcoError {
  if (status === 401) return new PcoError('auth', 'Planning Center rejected the credentials. Check the Application ID and Secret.', status);
  if (status === 403) return new PcoError('forbidden', 'This Planning Center account has no access to Services, or to this resource.', status);
  if (status === 404) return new PcoError('not-found', `Not found in Planning Center: ${path}`, status);
  if (status === 429) return new PcoError('rate-limited', 'Planning Center rate limit reached; try again shortly.', status);
  return new PcoError('http', `Planning Center returned HTTP ${status} for ${path}`, status);
}
