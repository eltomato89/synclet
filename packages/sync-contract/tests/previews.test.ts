import type { SyncItem } from '@synclet/shared';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { arrayErrors, schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A valid RGB PNG with random pixels (unique content, so no thumbnail exists for it yet). */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

describe('thumbnails', () => {
  let box: SyncItem;
  let image: SyncItem;

  beforeAll(async () => {
    box = await scratchFolder(api, ctx, 'thumbs');
    image = await uploadFile(api, box.id, 'pixels.png', png(64, 48));
  });

  it('image files report preview.kind image', () => {
    expect(image.preview).toMatchObject({ kind: 'image' });
    expect(image.mime).toBe('image/png');
  });

  it('404 not_found until the worker produced it, then 200 image/webp (poll)', async (t) => {
    if (ctx.skipThumbnails) t.skip(ctx.skipThumbnails);
    const url = `/sync/v1/items/${image.id}/thumbnail`;
    const deadline = Date.now() + ctx.thumbnailTimeoutMs;
    let res = await api.get(url);
    while (res.status === 404 && Date.now() < deadline) {
      expect(res.json()).toMatchObject({ statusCode: 404, code: 'not_found' });
      await sleep(500);
      res = await api.get(url);
    }
    if (res.status === 404) throw new Error(`no thumbnail after ${ctx.thumbnailTimeoutMs} ms – is the derivatives worker running? (set SYNCLET_SKIP_THUMBNAILS=1 to skip)`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.body.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(res.body.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect(res.headers.get('etag')).toBe(`"${image.sha256}-256"`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect((await api.get(url, { headers: { 'if-none-match': `"${image.sha256}-256"` } })).status).toBe(304);
    const large = await api.get(`${url}?size=1024`);
    expect(large.status).toBe(200);
    expect(large.headers.get('etag')).toBe(`"${image.sha256}-1024"`);
    // The item now says a thumbnail exists (not journaled: seen on the next read).
    expect((await api.get(`/sync/v1/items/${image.id}`)).json().preview).toMatchObject({ kind: 'image', thumbnail: true });
    // Preview tokens open the thumbnail route without Authorization.
    const dt = (await api.post(`/sync/v1/items/${image.id}/download-token?purpose=preview`)).json();
    expect((await api.get(`${url}?dt=${encodeURIComponent(dt.token)}`, { token: null })).status).toBe(200);
  });

  it('size other than 256/1024 is 400; folders are 400; files without thumbnail kind stay 404', async () => {
    expect((await api.get(`/sync/v1/items/${image.id}/thumbnail?size=512`)).json().code).toBe('invalid_request');
    expect((await api.get(`/sync/v1/items/${box.id}/thumbnail`)).status).toBe(400);
    const txt = await uploadFile(api, box.id, 'note.bin', randomBytes(32));
    const res = await api.get(`/sync/v1/items/${txt.id}/thumbnail`);
    expect(res.status).toBe(404);
    expect(res.json().code).toBe('not_found');
  });
});

describe('preview-text', () => {
  it('returns decoded text of text/markdown/code files', async () => {
    const box = await scratchFolder(api, ctx, 'ptext');
    const md = await uploadFile(api, box.id, 'readme.md', '# Hällo\n');
    expect(md.preview).toMatchObject({ kind: 'markdown' });
    const res = await api.get(`/sync/v1/items/${md.id}/preview-text`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(schemaErrors('PreviewText', res.json())).toBe('');
    expect(res.json()).toEqual({ text: '# Hällo\n', truncated: false, encoding: 'utf-8' });
    const latin = await uploadFile(api, box.id, 'old.txt', Buffer.from([0x48, 0xe4, 0x6c, 0x6c, 0x6f]));
    expect((await api.get(`/sync/v1/items/${latin.id}/preview-text`)).json()).toEqual({ text: 'Hällo', truncated: false, encoding: 'latin1' });
    const code = await uploadFile(api, box.id, 'main.ts', 'export {};\n');
    expect(code.preview).toMatchObject({ kind: 'code', language: 'typescript' });
  });

  it('truncates at 256 KiB', async () => {
    const box = await scratchFolder(api, ctx, 'ptext');
    const big = await uploadFile(api, box.id, 'big.txt', 'a'.repeat(300 * 1024));
    const body = (await api.get(`/sync/v1/items/${big.id}/preview-text`)).json();
    expect(body.truncated).toBe(true);
    expect(body.text.length).toBe(256 * 1024);
  });

  it('other file types are 415 invalid_request', async () => {
    const box = await scratchFolder(api, ctx, 'ptext');
    const bin = await uploadFile(api, box.id, 'x.png', png(2, 2));
    const res = await api.get(`/sync/v1/items/${bin.id}/preview-text`);
    expect(res.status).toBe(415);
    expect(res.json()).toMatchObject({ statusCode: 415, code: 'invalid_request' });
  });
});

describe('search and recent', () => {
  it('finds files by name; hits carry the item and its parent path', async () => {
    const box = await scratchFolder(api, ctx, 'search');
    const token = `zqx${Math.random().toString(36).slice(2, 8)}`;
    const f = await uploadFile(api, box.id, `${token}-notes.txt`, 'content');
    const res = await api.get(`/sync/v1/search?q=${token}`);
    expect(res.status).toBe(200);
    const body = res.json();
    expect(schemaErrors('SearchResponse', body)).toBe('');
    const hit = body.hits.find((h: { item: SyncItem }) => h.item.id === f.id);
    expect(hit).toMatchObject({ path: `${ctx.folderName}/${box.name}`, matched: 'name' });
    const scoped = (await api.get(`/sync/v1/search?q=${token}&folder=${box.id}`)).json();
    expect(scoped.hits.map((h: { item: SyncItem }) => h.item.id)).toContain(f.id);
  });

  it('rejects empty queries and bad folder ids with 400', async () => {
    expect((await api.get('/sync/v1/search?q=')).json().code).toBe('invalid_request');
    expect((await api.get('/sync/v1/search?q=a&folder=nope')).status).toBe(400);
  });

  it('recent lists files, newest modifiedAt first', async () => {
    const box = await scratchFolder(api, ctx, 'recent');
    const f = await uploadFile(api, box.id, 'fresh.txt', 'fresh');
    const res = await api.get('/sync/v1/recent?limit=200');
    expect(res.status).toBe(200);
    const items = res.json<SyncItem[]>();
    expect(arrayErrors('SyncItem', items)).toBe('');
    expect(items.every((i) => i.type === 'file')).toBe(true);
    const times = items.map((i) => new Date(i.modifiedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(items.map((i) => i.id)).toContain(f.id);
  });
});
