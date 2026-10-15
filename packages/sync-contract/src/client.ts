// Minimal HTTP client for the Synclet Sync API v1, used by the conformance suite.
// Deliberately thin: tests assert on raw status codes and headers, not on a client abstraction.

export interface Res {
  status: number;
  headers: Headers;
  body: Buffer;
  text(): string;
  /** Parsed JSON body (throws on invalid JSON). */
  json<T = any>(): T;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** JSON body (sets Content-Type: application/json). */
  json?: unknown;
  /** Raw body, sent as given (set Content-Type yourself). */
  body?: Uint8Array | string;
  /** Override the client's token; `null` sends no Authorization header. */
  token?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest total wait on 429 rate limiting (public auth routes are limited per client IP). */
const MAX_RATE_LIMIT_WAIT_MS = 120_000;

export class SyncletClient {
  /** `baseUrl` = server origin, e.g. http://localhost:3190 (the API lives under /api). */
  constructor(readonly baseUrl: string, public token: string | null = null) {}

  withToken(token: string | null): SyncletClient {
    return new SyncletClient(this.baseUrl, token);
  }

  /** `path` is relative to `/api`, e.g. `/sync/v1/account`. Absolute `/api/...` paths are kept. */
  url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/api/') ? path : `/api${path}`}`;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const token = opts.token === undefined ? this.token : opts.token;
    if (token && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) headers.authorization = `Bearer ${token}`;
    let body: Uint8Array | string | undefined = opts.body;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    let waited = 0;
    for (;;) {
      const res = await fetch(this.url(path), { method, headers, body: typeof body === 'string' || body === undefined ? body : new Uint8Array(body), redirect: 'manual' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 429 && waited < MAX_RATE_LIMIT_WAIT_MS) {
        // Rate limited (login/app-login routes): honour Retry-After and try again.
        const ms = Math.max(1, Number(res.headers.get('retry-after') ?? '6')) * 1000;
        waited += ms;
        await sleep(ms);
        continue;
      }
      return {
        status: res.status,
        headers: res.headers,
        body: buf,
        text: () => buf.toString('utf8'),
        json: () => JSON.parse(buf.toString('utf8')),
      };
    }
  }

  get(path: string, opts?: RequestOptions) { return this.request('GET', path, opts); }
  post(path: string, json?: unknown, opts: RequestOptions = {}) { return this.request('POST', path, { ...opts, json }); }
  patch(path: string, json: unknown, opts: RequestOptions = {}) { return this.request('PATCH', path, { ...opts, json }); }
  del(path: string, opts?: RequestOptions) { return this.request('DELETE', path, opts); }

  /** `POST /sync/v1/items/upload` with a raw body. */
  upload(parentId: string, name: string, data: Uint8Array | string, opts: { onConflict?: 'fail' | 'rename'; headers?: Record<string, string> } = {}) {
    const q = new URLSearchParams({ parentId, name, ...(opts.onConflict ? { onConflict: opts.onConflict } : {}) });
    return this.request('POST', `/sync/v1/items/upload?${q}`, {
      body: typeof data === 'string' ? Buffer.from(data) : data,
      headers: { 'content-type': 'application/octet-stream', ...(opts.headers ?? {}) },
    });
  }

  /** `PUT /sync/v1/items/:id/content` with a raw body; `ifMatch` undefined = header omitted. */
  replace(id: string, data: Uint8Array | string, ifMatch?: string, headers: Record<string, string> = {}) {
    return this.request('PUT', `/sync/v1/items/${id}/content`, {
      body: typeof data === 'string' ? Buffer.from(data) : data,
      headers: { 'content-type': 'application/octet-stream', ...(ifMatch !== undefined ? { 'if-match': ifMatch } : {}), ...headers },
    });
  }

  /** `POST /sync/v1/items` (create folder). */
  mkdir(parentId: string, name: string, onConflict?: 'fail' | 'rename') {
    return this.post('/sync/v1/items', { parentId, type: 'folder', name, ...(onConflict ? { onConflict } : {}) });
  }
}

/** Throws with the response body when the status differs (for setup steps, not for assertions). */
export function expectStatus(res: Res, status: number, what: string): Res {
  if (res.status !== status) throw new Error(`${what}: expected HTTP ${status}, got ${res.status}: ${res.text().slice(0, 500)}`);
  return res;
}

/** tus `Upload-Metadata` header value (keys with base64 values). */
export function tusMetadata(meta: Record<string, string>): string {
  return Object.entries(meta).map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`).join(',');
}

export const randomSuffix = () => Math.random().toString(36).slice(2, 10);
