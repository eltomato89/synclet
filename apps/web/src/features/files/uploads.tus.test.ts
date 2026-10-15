import type { SyncItem } from '@synclet/shared';
import type { DetailedError, HttpRequest, HttpResponse, PreviousUpload, UploadOptions } from 'tus-js-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearUploadFingerprints, itemFromResponse, tokenExpiry, TUS_CHUNK_SIZE, TUS_ENDPOINT, TUS_RETRY_DELAYS, type UploadTransport, UploadQueue,
} from './uploads';

const item = (id = 'f_1', name = 'a.txt') => ({ id, name }) as SyncItem;

function response(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  return {
    getStatus: () => status,
    getHeader: (h: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === h.toLowerCase())?.[1],
    getBody: () => body,
    getUnderlyingObject: () => null,
  };
}
const itemResponse = (it: SyncItem, status = 200) => response(status, JSON.stringify(it), { 'X-Synclet-Item': it.id });

function request(method = 'PATCH'): HttpRequest & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    getMethod: () => method, getURL: () => '', setHeader: (k, v) => { headers[k] = v; }, getHeader: (k) => headers[k],
    setProgressHandler: () => {}, send: () => Promise.reject(new Error('unused')), abort: () => Promise.resolve(), getUnderlyingObject: () => null,
  };
}
function httpError(status: number, body = ''): DetailedError {
  return Object.assign(new Error(`HTTP ${status}`), { originalRequest: request(), originalResponse: status ? response(status, body) : null, causingError: null });
}

/** Stand-in for tus.Upload: records options and lets the test drive the callbacks. */
class FakeUpload {
  static instances: FakeUpload[] = [];
  static previous: PreviousUpload[] = [];
  url: string | null = null;
  started = false;
  resumedFrom: PreviousUpload | null = null;
  aborted: boolean | undefined;
  constructor(readonly file: File, readonly options: UploadOptions) { FakeUpload.instances.push(this); }
  start() { this.started = true; }
  abort(terminate?: boolean) { this.aborted = !!terminate; return Promise.resolve(); }
  findPreviousUploads() { return Promise.resolve(FakeUpload.previous); }
  resumeFromPreviousUpload(p: PreviousUpload) { this.resumedFrom = p; this.url = p.uploadUrl; }
  /** Runs onShouldRetry like tus-js-client would and reports its verdict. */
  shouldRetry(err: DetailedError) { return this.options.onShouldRetry!(err, 0, this.options); }
}

const TUS: UploadTransport = { Upload: FakeUpload as unknown as UploadTransport['Upload'], supported: true, publishRetryMs: 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));
const file = (name = 'a.txt', size = 4) => new File(['x'.repeat(size)], name, { type: 'text/plain', lastModified: Date.UTC(2024, 0, 2) });

function setup(refresh?: () => Promise<boolean>, token = () => 'tok') {
  FakeUpload.instances = [];
  FakeUpload.previous = [];
  const done = vi.fn();
  return { q: new UploadQueue(token, done, refresh, TUS), done };
}
async function started(q: UploadQueue, files: File[], parentId = 'd_1') {
  q.enqueue(files, parentId);
  await flush();
  return FakeUpload.instances;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('UploadQueue over tus', () => {
  it('configures each upload: endpoint, chunks, retries, metadata, fingerprint per folder', async () => {
    const { q } = setup();
    const [u] = await started(q, [file()]);
    const o = u.options;
    expect(o.endpoint).toBe(new URL(TUS_ENDPOINT, window.location.href).href);
    expect(o.chunkSize).toBe(TUS_CHUNK_SIZE);
    expect(o.retryDelays).toEqual(TUS_RETRY_DELAYS);
    expect(o.removeFingerprintOnSuccess).toBe(true);
    expect(o.metadata).toEqual({ name: 'a.txt', parentId: 'd_1', onConflict: 'rename', modifiedAt: '2024-01-02T00:00:00.000Z' });
    const fp = await o.fingerprint!(u.file, o);
    expect(fp).toContain('d_1');
    expect(u.started).toBe(true);
  });

  it('sets the current access token on every request', async () => {
    let tok = 'one';
    const { q } = setup(undefined, () => tok);
    const [u] = await started(q, [file()]);
    const r1 = request();
    await u.options.onBeforeRequest!(r1);
    tok = 'two';
    const r2 = request();
    await u.options.onBeforeRequest!(r2);
    expect([r1.headers.Authorization, r2.headers.Authorization]).toEqual(['Bearer one', 'Bearer two']);
  });

  it('reports progress and finishes with the SyncItem of the last response', async () => {
    const { q, done } = setup();
    const [u] = await started(q, [file()]);
    u.options.onProgress!(1, 4);
    expect(q.snapshot()[0]).toMatchObject({ status: 'uploading', progress: 0.25 });
    u.options.onSuccess!({ lastResponse: itemResponse(item('f_9', 'a (2).txt')) });
    await flush();
    expect(q.snapshot()[0]).toMatchObject({ status: 'done', progress: 1, result: { id: 'f_9', name: 'a (2).txt' } });
    expect(done).toHaveBeenCalledWith('d_1');
  });

  it('runs at most three uploads at once', async () => {
    const { q } = setup();
    const ups = await started(q, [file('1'), file('2'), file('3'), file('4')]);
    expect(ups).toHaveLength(3);
    ups[0].options.onSuccess!({ lastResponse: itemResponse(item()) });
    await flush(); await flush();
    expect(FakeUpload.instances).toHaveLength(4);
  });

  it('resumes the most recent previous upload of the same file', async () => {
    const { q } = setup();
    FakeUpload.previous = [
      { size: 4, metadata: {}, creationTime: '2024-01-01T00:00:00Z', urlStorageKey: 'k1', uploadUrl: 'http://x/api/sync/v1/uploads/old', parallelUploadUrls: null },
      { size: 4, metadata: {}, creationTime: '2024-01-03T00:00:00Z', urlStorageKey: 'k2', uploadUrl: 'http://x/api/sync/v1/uploads/new', parallelUploadUrls: null },
    ];
    q.enqueue([file()], 'd_1');
    await flush();
    const [u] = FakeUpload.instances;
    expect(u.resumedFrom?.urlStorageKey).toBe('k2');
    expect(u.started).toBe(true);
  });

  it('maps errors: Sync API codes, HTTP status, network', async () => {
    const { q } = setup();
    const [a, b, c] = await started(q, [file('a'), file('b'), file('c')]);
    a.options.onError!(httpError(400, JSON.stringify({ code: 'invalid_name' })));
    b.options.onError!(httpError(413, 'Maximum size exceeded\n'));
    c.options.onError!(httpError(0));
    await flush();
    expect(q.snapshot().map((t) => [t.status, t.error])).toEqual([['error', 'invalid_name'], ['error', 'too_large'], ['error', 'network']]);
  });

  it('does not retry Sync API errors, retries transient failures', async () => {
    const { q } = setup();
    const [u] = await started(q, [file()]);
    expect(u.shouldRetry(httpError(404, JSON.stringify({ code: 'not_found' })))).toBe(false);
    expect(u.shouldRetry(httpError(400, 'bad'))).toBe(false);
    expect(u.shouldRetry(httpError(500))).toBe(true);
    expect(u.shouldRetry(httpError(423, 'Upload is being finished\n'))).toBe(true);
    expect(u.shouldRetry(httpError(0))).toBe(true);
  });

  it('refreshes the session on 401 before retrying, and gives up on a second 401', async () => {
    let tok = 'old';
    const refresh = vi.fn(async () => { tok = 'new'; return true; });
    const { q } = setup(refresh, () => tok);
    const [u] = await started(q, [file()]);
    expect(u.shouldRetry(httpError(401))).toBe(true);
    const r = request();
    await u.options.onBeforeRequest!(r);
    expect(r.headers.Authorization).toBe('Bearer new');
    expect(u.shouldRetry(httpError(401))).toBe(false);
    u.options.onError!(httpError(401));
    await flush();
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'unauthorized' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('cancel terminates the upload on the server', async () => {
    const { q } = setup();
    const [u] = await started(q, [file()]);
    q.cancel(q.snapshot()[0].id);
    expect(u.aborted).toBe(true);
    expect(q.snapshot()).toHaveLength(0);
  });

  it('retry after an error starts a new tus upload (which resumes via its fingerprint)', async () => {
    const { q } = setup();
    const [u] = await started(q, [file()]);
    u.options.onError!(httpError(0));
    await flush();
    q.retry(q.snapshot()[0].id);
    await flush();
    expect(FakeUpload.instances).toHaveLength(2);
    expect(FakeUpload.instances[1].started).toBe(true);
  });

  describe('success without an item (publish failed earlier)', () => {
    const headOnly = response(200, '', { 'Upload-Offset': '4', 'Upload-Length': '4' });

    it('sends an empty PATCH at the final offset and takes the item from it', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(item('f_5')), { status: 200, headers: { 'X-Synclet-Item': 'f_5' } }));
      vi.stubGlobal('fetch', fetchMock);
      const { q, done } = setup();
      const [u] = await started(q, [file()]);
      u.url = 'http://localhost/api/sync/v1/uploads/abc';
      u.options.onSuccess!({ lastResponse: headOnly });
      await flush(); await flush();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost/api/sync/v1/uploads/abc');
      expect(init.method).toBe('PATCH');
      expect(init.headers).toMatchObject({ 'Upload-Offset': '4', 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', Authorization: 'Bearer tok' });
      expect(q.snapshot()[0]).toMatchObject({ status: 'done', result: { id: 'f_5' } });
      expect(done).toHaveBeenCalledWith('d_1');
    });

    it('asks again while the server answers 423 and fails after three attempts', async () => {
      const fetchMock = vi.fn().mockImplementation(async () => new Response('Upload is being finished\n', { status: 423 }));
      vi.stubGlobal('fetch', fetchMock);
      const { q, done } = setup();
      const [u] = await started(q, [file()]);
      u.url = 'http://localhost/api/sync/v1/uploads/abc';
      u.options.onSuccess!({ lastResponse: headOnly });
      for (let i = 0; i < 10; i++) await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'server_error' });
      expect(done).not.toHaveBeenCalled();
    });

    it('a 423 followed by the item succeeds', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('locked', { status: 423 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(item('f_6')), { status: 200, headers: { 'X-Synclet-Item': 'f_6' } }));
      vi.stubGlobal('fetch', fetchMock);
      const { q } = setup();
      const [u] = await started(q, [file()]);
      u.url = 'http://localhost/api/sync/v1/uploads/abc';
      u.options.onSuccess!({ lastResponse: headOnly });
      for (let i = 0; i < 6; i++) await flush();
      expect(q.snapshot()[0]).toMatchObject({ status: 'done', result: { id: 'f_6' } });
    });

    it('a Sync API error from the publish is surfaced', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'not_found' }), { status: 404 })));
      const { q } = setup();
      const [u] = await started(q, [file()]);
      u.url = 'http://localhost/api/sync/v1/uploads/abc';
      u.options.onSuccess!({ lastResponse: headOnly });
      for (let i = 0; i < 4; i++) await flush();
      expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'not_found' });
    });
  });
});

/** An unsigned JWT whose `exp` is `inMs` from now. */
const jwt = (inMs: number, tag = 'x') => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: tag, exp: Math.floor((Date.now() + inMs) / 1000) })}.sig`;
};

describe('token refresh before requests', () => {
  it('reads exp from a JWT payload', () => {
    const tok = jwt(60_000);
    expect(tokenExpiry(tok)).toBeGreaterThan(Date.now() + 50_000);
    expect(tokenExpiry('garbage')).toBeNull();
    expect(tokenExpiry(null)).toBeNull();
  });

  it('a resumed HEAD with an (almost) expired token refreshes first and carries the new token', async () => {
    let tok = jwt(10_000, 'old');
    const order: string[] = [];
    const refresh = vi.fn(async () => { order.push('refresh'); tok = jwt(15 * 60_000, 'new'); return true; });
    const { q } = setup(refresh, () => tok);
    FakeUpload.previous = [{ size: 4, metadata: {}, creationTime: '2024-01-03T00:00:00Z', urlStorageKey: 'k', uploadUrl: 'http://localhost/api/sync/v1/uploads/u1', parallelUploadUrls: null }];
    q.enqueue([file()], 'd_1');
    await flush();
    const [u] = FakeUpload.instances;
    expect(u.resumedFrom?.uploadUrl).toBe('http://localhost/api/sync/v1/uploads/u1');
    // Two requests at once (e.g. HEAD after a retry and a racing one) share one refresh.
    const head = request('HEAD');
    const other = request('HEAD');
    await Promise.all([u.options.onBeforeRequest!(head), u.options.onBeforeRequest!(other)].map((p) => Promise.resolve(p).then(() => order.push('sent'))));
    expect(order[0]).toBe('refresh');
    expect(head.headers.Authorization).toBe(`Bearer ${tok}`);
    expect(tokenExpiry(head.headers.Authorization.slice(7))! - Date.now()).toBeGreaterThan(60_000);
    // The upload carries on from the stored URL: no new tus upload was created.
    expect(FakeUpload.instances).toHaveLength(1);
  });

  it('does not refresh while the token is fresh', async () => {
    const refresh = vi.fn(async () => true);
    const tok = jwt(10 * 60_000);
    const { q } = setup(refresh, () => tok);
    const [u] = await started(q, [file()]);
    const r = request('HEAD');
    await u.options.onBeforeRequest!(r);
    expect(refresh).not.toHaveBeenCalled();
    expect(r.headers.Authorization).toBe(`Bearer ${tok}`);
  });
});

describe('410 and logout', () => {
  it('maps 410 to upload_expired', async () => {
    const { q } = setup();
    const [u] = await started(q, [file()]);
    u.options.onError!(httpError(410, 'The file for this url no longer exists\n'));
    await flush();
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'upload_expired' });
  });

  it('clearUploadFingerprints removes only tus entries', () => {
    localStorage.setItem('tus::synclet|root|a.txt::1', '{}');
    localStorage.setItem('tus::synclet|d_1|b.txt::2', '{}');
    localStorage.setItem('synclet.files.view', '"list"');
    clearUploadFingerprints();
    expect(Object.keys(localStorage)).toEqual(['synclet.files.view']);
  });
});

describe('itemFromResponse', () => {
  it('accepts 200/201 with a matching X-Synclet-Item only', () => {
    expect(itemFromResponse(itemResponse(item('f_1')))?.id).toBe('f_1');
    expect(itemFromResponse(itemResponse(item('f_1'), 201))?.id).toBe('f_1');
    expect(itemFromResponse(response(200, JSON.stringify(item('f_1'))))).toBeNull();
    expect(itemFromResponse(response(200, JSON.stringify(item('f_1')), { 'X-Synclet-Item': 'f_2' }))).toBeNull();
    expect(itemFromResponse(response(204, '', { 'X-Synclet-Item': 'f_1' }))).toBeNull();
    expect(itemFromResponse(response(200, '<html>', { 'X-Synclet-Item': 'f_1' }))).toBeNull();
  });
});
