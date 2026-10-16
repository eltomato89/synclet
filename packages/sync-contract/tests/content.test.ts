import type { SyncItem } from '@synclet/shared';
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();
const DATA = randomBytes(10_000);

describe('content download', () => {
  let file: SyncItem;
  let box: SyncItem;
  const url = () => `/sync/v1/items/${file.id}/content`;

  beforeAll(async () => {
    box = await scratchFolder(api, ctx, 'content');
    file = await uploadFile(api, box.id, 'data.bin', DATA);
  });

  it('upload reports size, version 1 and the sha256 of the bytes', () => {
    expect(file).toMatchObject({ size: DATA.length, version: 1, etag: 'v1', contentEtag: 'v1', mime: 'application/octet-stream' });
    expect(file.sha256).toBe(createHash('sha256').update(DATA).digest('hex'));
  });

  it('full download: 200 with ETag, Content-Length, Accept-Ranges, Last-Modified, no-store', async () => {
    const res = await api.get(url());
    expect(res.status).toBe(200);
    expect(res.body.equals(DATA)).toBe(true);
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(res.headers.get('content-length')).toBe(String(DATA.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(new Date(res.headers.get('last-modified')!).getTime()).toBe(Math.floor(new Date(file.modifiedAt).getTime() / 1000) * 1000);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('download=1 adds an attachment Content-Disposition with the UTF-8 name', async () => {
    const named = await uploadFile(api, box.id, 'Grüße (1).txt', 'hi');
    const res = await api.get(`/sync/v1/items/${named.id}/content?download=1`);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Gr__e (1).txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%281%29.txt`);
  });

  it('Range: 206 with Content-Range for a-b, a- and -n', async () => {
    const cases: [string, number, number][] = [['bytes=0-99', 0, 99], ['bytes=9990-', 9990, 9999], ['bytes=-10', 9990, 9999], ['bytes=100-999999', 100, 9999]];
    for (const [range, start, end] of cases) {
      const res = await api.get(url(), { headers: { range } });
      expect(res.status, range).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/${DATA.length}`);
      expect(res.headers.get('content-length')).toBe(String(end - start + 1));
      expect(res.headers.get('etag')).toBe('"v1"');
      expect(res.body.equals(DATA.subarray(start, end + 1))).toBe(true);
    }
  });

  it('unsatisfiable Range: 416 range_not_satisfiable with Content-Range bytes */size', async () => {
    for (const range of ['bytes=10000-', 'bytes=-0', 'bytes=50-10']) {
      const res = await api.get(url(), { headers: { range } });
      expect(res.status, range).toBe(416);
      expect(res.headers.get('content-range')).toBe(`bytes */${DATA.length}`);
      expect(res.json()).toMatchObject({ statusCode: 416, code: 'range_not_satisfiable' });
    }
  });

  it('unsupported Range forms (multiple ranges, other units) send the full content', async () => {
    for (const range of ['bytes=0-1,5-6', 'items=0-1']) {
      const res = await api.get(url(), { headers: { range } });
      expect(res.status, range).toBe(200);
      expect(res.body.length).toBe(DATA.length);
    }
  });

  it('If-None-Match: 304 for the current etag (also in a list, weak or *), 200 otherwise', async () => {
    for (const inm of ['"v1"', 'W/"v1"', '"v0", "v1"', '*']) {
      const res = await api.get(url(), { headers: { 'if-none-match': inm } });
      expect(res.status, inm).toBe(304);
      expect(res.body.length).toBe(0);
    }
    expect((await api.get(url(), { headers: { 'if-none-match': '"v7"' } })).status).toBe(200);
  });

  it('If-Range: resumes (206) only with the current strong etag or the exact Last-Modified', async () => {
    const lastModified = (await api.get(url(), { headers: { range: 'bytes=0-0' } })).headers.get('last-modified')!;
    const ok = await api.get(url(), { headers: { range: 'bytes=10-19', 'if-range': '"v1"' } });
    expect(ok.status).toBe(206);
    const byDate = await api.get(url(), { headers: { range: 'bytes=10-19', 'if-range': lastModified } });
    expect(byDate.status).toBe(206);
    for (const ifRange of ['"v0"', 'W/"v1"', 'Thu, 01 Jan 1970 00:00:00 GMT']) {
      const res = await api.get(url(), { headers: { range: 'bytes=10-19', 'if-range': ifRange } });
      expect(res.status, ifRange).toBe(200);
      expect(res.body.equals(DATA)).toBe(true);
    }
  });

  it('empty files download as 200 with Content-Length 0; ranges on them are 416', async () => {
    const empty = await uploadFile(api, box.id, 'empty.txt', '');
    expect(empty).toMatchObject({ size: 0, version: 1, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    const res = await api.get(`/sync/v1/items/${empty.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect((await api.get(`/sync/v1/items/${empty.id}/content`, { headers: { range: 'bytes=0-' } })).status).toBe(416);
  });

  it('content of a folder is 400 invalid_request', async () => {
    const res = await api.get(`/sync/v1/items/${box.id}/content`);
    expect(res.status).toBe(400);
    expect(res.json().code).toBe('invalid_request');
  });
});

describe('download tokens', () => {
  let file: SyncItem;
  let other: SyncItem;
  let box: SyncItem;

  beforeAll(async () => {
    box = await scratchFolder(api, ctx, 'dt');
    file = await uploadFile(api, box.id, 'report.pdf', '%PDF-1.4 fake');
    other = await uploadFile(api, box.id, 'other.txt', 'other');
  });

  it('download purpose: URL with download=1 that works without Authorization (attachment)', async () => {
    const res = await api.post(`/sync/v1/items/${file.id}/download-token`);
    expect(res.status).toBe(201);
    const dt = res.json();
    expect(schemaErrors('DownloadToken', dt)).toBe('');
    expect(dt.url).toBe(`/api/sync/v1/items/${file.id}/content?download=1&dt=${encodeURIComponent(dt.token)}`);
    const ttl = new Date(dt.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(30_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
    const dl = await api.get(dt.url, { token: null });
    expect(dl.status).toBe(200);
    expect(dl.text()).toBe('%PDF-1.4 fake');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="report.pdf"/);
  });

  it('preview purpose: inline URL (no download=1), valid for hours', async () => {
    const dt = (await api.post(`/sync/v1/items/${file.id}/download-token?purpose=preview`)).json();
    expect(dt.url).toBe(`/api/sync/v1/items/${file.id}/content?dt=${encodeURIComponent(dt.token)}`);
    expect(new Date(dt.expiresAt).getTime() - Date.now()).toBeGreaterThan(5 * 3600_000);
    const res = await api.get(dt.url, { token: null });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('a token is bound to its item: another item answers 401', async () => {
    const dt = (await api.post(`/sync/v1/items/${file.id}/download-token`)).json();
    const res = await api.get(`/sync/v1/items/${other.id}/content?dt=${encodeURIComponent(dt.token)}`, { token: null });
    expect(res.status).toBe(401);
    expect(res.json().code).toBe('unauthorized');
    // Not accepted by routes outside content/thumbnail/version content.
    expect((await api.get(`/sync/v1/items/${file.id}?dt=${encodeURIComponent(dt.token)}`, { token: null })).status).toBe(401);
  });

  it('folders and unknown purposes are 400 invalid_request', async () => {
    expect((await api.post(`/sync/v1/items/${box.id}/download-token`)).json().code).toBe('invalid_request');
    expect((await api.post(`/sync/v1/items/${file.id}/download-token?purpose=forever`)).status).toBe(400);
  });
});
