/**
 * Resume behaviour with the real tus-js-client: only the HTTP stack, URL storage and file reader
 * are fakes. Covers the expired-session path: a request that would carry an unusable token is
 * never sent, the stored upload URL survives, and Retry resumes from the server offset.
 */
import type { SyncItem } from '@synclet/shared';
import * as tus from 'tus-js-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenExpiry, type UploadTransport, UploadQueue } from './uploads';

const UPLOAD_URL = 'http://localhost:3000/api/sync/v1/uploads/u-1';
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const jwt = (inMs: number, tag: string) => {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: tag, exp: Math.floor((Date.now() + inMs) / 1000) })}.sig`;
};

/** A tus server for one upload: HEAD reports the offset, PATCH appends, the final PATCH publishes. */
class FakeServer {
  sent: { method: string; url: string; auth?: string }[] = [];
  constructor(public offset: number, readonly length: number) {}
  stack(): tus.HttpStack {
    const server = this;
    return {
      getName: () => 'fake',
      createRequest(method: string, url: string) {
        const headers: Record<string, string> = {};
        return {
          getMethod: () => method, getURL: () => url,
          setHeader: (k: string, v: string) => { headers[k] = v; }, getHeader: (k: string) => headers[k],
          setProgressHandler: () => {}, abort: () => Promise.resolve(), getUnderlyingObject: () => null,
          send: async (body?: Blob) => server.handle(method, url, headers, body),
        };
      },
    };
  }
  private handle(method: string, url: string, headers: Record<string, string>, body?: Blob): tus.HttpResponse {
    this.sent.push({ method, url, auth: headers.Authorization });
    const exp = tokenExpiry(headers.Authorization?.slice(7) ?? null);
    if (exp === null || exp <= Date.now()) return res(401, '{"code":"unauthorized"}');
    if (method === 'POST') return res(201, '', { Location: '/api/sync/v1/uploads/u-new' });
    if (method === 'HEAD') return res(200, '', { 'Upload-Offset': String(this.offset), 'Upload-Length': String(this.length) });
    if (method === 'PATCH') {
      this.offset += body?.size ?? 0;
      if (this.offset < this.length) return res(204, '', { 'Upload-Offset': String(this.offset) });
      const item = { id: 'f_done', name: 'a.txt' } as SyncItem;
      return res(200, JSON.stringify(item), { 'Upload-Offset': String(this.offset), 'X-Synclet-Item': item.id });
    }
    return res(405, '');
  }
}
function res(status: number, body: string, headers: Record<string, string> = {}): tus.HttpResponse {
  return {
    getStatus: () => status, getBody: () => body, getUnderlyingObject: () => null,
    getHeader: (h: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === h.toLowerCase())?.[1],
  };
}

/** localStorage-like URL storage (the node build of tus-js-client has none). */
class MemoryUrlStorage implements tus.UrlStorage {
  entries = new Map<string, tus.PreviousUpload & { fingerprint: string }>();
  private n = 0;
  async findAllUploads() { return [...this.entries.values()]; }
  async findUploadsByFingerprint(fp: string) { return [...this.entries.values()].filter((e) => e.fingerprint === fp); }
  async removeUpload(key: string) { this.entries.delete(key); }
  async addUpload(fp: string, upload: tus.PreviousUpload) {
    const key = `tus::${fp}::${++this.n}`;
    this.entries.set(key, { ...upload, urlStorageKey: key, fingerprint: fp });
    return key;
  }
}

const blobReader = {
  openFile: async (input: Blob) => ({
    size: input.size,
    slice: async (start: number, end: number) => ({ value: input.slice(start, end), done: end >= input.size }),
    close: () => {},
  }),
};

function setup(refresh: () => Promise<boolean>, token: () => string | null) {
  const server = new FakeServer(4, 10);
  const storage = new MemoryUrlStorage();
  class TestUpload extends tus.Upload {
    constructor(file: File, options: tus.UploadOptions) {
      super(file, { ...options, httpStack: server.stack(), urlStorage: storage, fileReader: blobReader as unknown as tus.UploadOptions['fileReader'] });
    }
  }
  const transport: UploadTransport = { Upload: TestUpload, supported: true, publishRetryMs: 0 };
  const done = vi.fn();
  const q = new UploadQueue(token, done, refresh, transport);
  const file = new File(['0123456789'], 'a.txt', { type: 'text/plain', lastModified: Date.UTC(2024, 0, 2) });
  // A previous page load uploaded 4 of 10 bytes into d_1.
  const fp = ['synclet', 'd_1', file.name, file.type, file.size, file.lastModified].join('|');
  void storage.addUpload(fp, { size: 10, metadata: {}, creationTime: new Date().toISOString(), urlStorageKey: '', uploadUrl: UPLOAD_URL, parallelUploadUrls: null });
  return { q, server, storage, file, done };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('resume with an expiring session (real tus-js-client)', () => {
  it('a failed refresh sends nothing, keeps the stored upload, and Retry resumes from the offset', async () => {
    let tok = jwt(5_000, 'old'); // inside the refresh margin
    let refreshWorks = false;
    const refresh = vi.fn(async () => {
      if (!refreshWorks) throw new Error('offline');
      tok = jwt(15 * 60_000, 'new');
      return true;
    });
    const { q, server, storage, file, done } = setup(refresh, () => tok);

    q.enqueue([file], 'd_1');
    await flush();
    expect(server.sent).toEqual([]); // no HEAD with a stale token
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'network' });
    expect([...storage.entries.values()].map((e) => e.uploadUrl)).toEqual([UPLOAD_URL]);

    refreshWorks = true;
    q.retry(q.snapshot()[0].id);
    await flush();
    expect(server.sent.map((r) => r.method)).toEqual(['HEAD', 'PATCH']); // resumed, no POST
    expect(server.sent.every((r) => r.url === UPLOAD_URL && r.auth === `Bearer ${tok}`)).toBe(true);
    expect(server.offset).toBe(10);
    expect(q.snapshot()[0]).toMatchObject({ status: 'done', result: { id: 'f_done' } });
    expect(done).toHaveBeenCalledWith('d_1');
    expect(storage.entries.size).toBe(0); // removeFingerprintOnSuccess
  });

  it('a session that is gone fails with unauthorized and keeps the stored upload', async () => {
    const { q, server, storage, file } = setup(vi.fn(async () => false), () => jwt(-60_000, 'expired'));
    q.enqueue([file], 'd_1');
    await flush();
    expect(server.sent).toEqual([]);
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'unauthorized' });
    expect(storage.entries.size).toBe(1);
  });

  it('a fresh token resumes straight away', async () => {
    const refresh = vi.fn(async () => true);
    const { q, server, file } = setup(refresh, () => jwt(10 * 60_000, 'fresh'));
    q.enqueue([file], 'd_1');
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    expect(server.sent.map((r) => r.method)).toEqual(['HEAD', 'PATCH']);
    expect(q.snapshot()[0].status).toBe('done');
  });
});
