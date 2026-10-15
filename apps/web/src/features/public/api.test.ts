import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorFrom, fetchShareInfo, listShareItems, PublicError, shareUrls, unlockShare, uploadToShare } from './api';

const TOKEN = 'lR9zzMewDYRVy0tlYwQ9158nOL8ut4E2BT4gU41Nyrg';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shareUrls', () => {
  const u = shareUrls(TOKEN);
  const base = `/api/public/shares/${TOKEN}`;

  it('builds every public route under the token path (where the unlock cookie is scoped)', () => {
    expect(u.info).toBe(base);
    expect(u.unlock).toBe(`${base}/unlock`);
    expect(u.items()).toBe(`${base}/items`);
    expect(u.items('d_1')).toBe(`${base}/items?folder=d_1`);
    expect(u.content('f_1')).toBe(`${base}/items/f_1/content`);
    expect(u.content('f_1', { download: true })).toBe(`${base}/items/f_1/content?download=1`);
    expect(u.thumbnail('f_1', 256)).toBe(`${base}/items/f_1/thumbnail?size=256`);
    expect(u.thumbnail('f_1', 1024)).toBe(`${base}/items/f_1/thumbnail?size=1024`);
    expect(u.zip()).toBe(`${base}/zip`);
    expect(u.zip('d_2')).toBe(`${base}/zip?folder=d_2`);
  });

  it('addresses the shared item itself with an empty id (file shares)', () => {
    expect(u.content('', { download: true })).toBe(`${base}/items//content?download=1`);
  });

  it('encodes ids, names and folders', () => {
    expect(u.content('a/../b')).toBe(`${base}/items/a%2F..%2Fb/content`);
    expect(u.upload('Bericht & Plan #1.pdf')).toBe(`${base}/upload?name=Bericht+%26+Plan+%231.pdf`);
    expect(u.upload('a.txt', 'd_9')).toBe(`${base}/upload?name=a.txt&folder=d_9`);
  });
});

describe('errorFrom', () => {
  it('keeps server codes and Retry-After', () => {
    const e = errorFrom(429, { code: 'rate_limited', message: 'slow down' }, '10');
    expect(e).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 10, message: 'slow down' });
  });
  it('maps 503 rate_limited (server at capacity) to busy', () => {
    expect(errorFrom(503, { code: 'rate_limited' }, '30')).toMatchObject({ status: 503, code: 'busy', retryAfter: 30 });
  });
  it('falls back for bodies without a code', () => {
    expect(errorFrom(502, null, null).code).toBe('server_error');
    expect(errorFrom(400, 'nope', null).code).toBe('unknown');
  });
});

describe('requests', () => {
  it('uses plain same-origin fetches without an Authorization header', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, []));
    await listShareItems(TOKEN, 'd_1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/public/shares/${TOKEN}/items?folder=d_1`);
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('turns failures into PublicError (401 password, 410 expired, network)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { code: 'share_password_required' }))
      .mockResolvedValueOnce(json(410, { code: 'share_expired' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchShareInfo(TOKEN)).rejects.toMatchObject({ status: 401, code: 'share_password_required' });
    await expect(fetchShareInfo(TOKEN)).rejects.toMatchObject({ status: 410, code: 'share_expired' });
    await expect(fetchShareInfo(TOKEN)).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('posts the password as JSON and resolves on 204', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(unlockShare(TOKEN, 'geheim')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/public/shares/${TOKEN}/unlock`);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ password: 'geheim' }) });
  });
});

/** Minimal XMLHttpRequest stand-in: records the request; the test completes it. */
class FakeXhr {
  static last: FakeXhr;
  method = ''; url = ''; body: unknown; status = 0; responseText = ''; responseType = '';
  headers: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  upload = { onprogress: null as ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  getResponseHeader(k: string) { return this.responseHeaders[k] ?? null; }
  send(body: unknown) { this.body = body; }
  abort() { this.onabort?.(); }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status; this.responseText = JSON.stringify(body); this.responseHeaders = headers; this.onload?.();
  }
}

describe('uploadToShare', () => {
  it('POSTs the raw file with progress and resolves with the (possibly renamed) entry', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress: number[] = [];
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    const p = uploadToShare(TOKEN, 'd_5', file, (f) => progress.push(f));
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(`/api/public/shares/${TOKEN}/upload?name=a.txt&folder=d_5`);
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect(xhr.body).toBe(file);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
    xhr.respond(201, { id: 'f_9', name: 'a (2).txt', type: 'file', size: 5, mime: 'text/plain', modifiedAt: '', hasThumbnail: false });
    await expect(p).resolves.toMatchObject({ name: 'a (2).txt' });
    expect(progress).toEqual([0.5, 1]);
  });

  it('rejects with the server error (413 too_large, 429 with Retry-After)', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const file = new File(['x'], 'x.bin');
    const big = uploadToShare(TOKEN, null, file, () => {});
    FakeXhr.last.respond(413, { code: 'too_large' });
    await expect(big).rejects.toMatchObject({ status: 413, code: 'too_large' });
    const limited = uploadToShare(TOKEN, null, file, () => {});
    FakeXhr.last.respond(429, { code: 'rate_limited' }, { 'Retry-After': '180' });
    const err = await limited.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicError);
    expect(err).toMatchObject({ code: 'rate_limited', retryAfter: 180 });
  });
});
