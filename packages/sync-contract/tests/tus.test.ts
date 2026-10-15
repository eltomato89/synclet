import type { SyncItem } from '@synclet/shared';
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { tusMetadata } from '../src/client.js';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();
const TUS = '/sync/v1/uploads';
const tusHeaders = (h: Record<string, string> = {}) => ({ 'tus-resumable': '1.0.0', ...h });

const create = (length: number, meta: Record<string, string>, body?: Buffer) => api.request('POST', TUS, {
  headers: tusHeaders({
    'upload-length': String(length), 'upload-metadata': tusMetadata(meta),
    ...(body ? { 'content-type': 'application/offset+octet-stream' } : {}),
  }),
  body,
});
const patch = (location: string, offset: number, chunk: Buffer) => api.request('PATCH', location, {
  headers: tusHeaders({ 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }),
  body: chunk,
});
const head = (location: string) => api.request('HEAD', location, { headers: tusHeaders() });

describe('tus resumable uploads', () => {
  let box: SyncItem;
  beforeAll(async () => { box = await scratchFolder(api, ctx, 'tus'); });

  it('OPTIONS advertises tus 1.0.0 and the size limit', async () => {
    const res = await api.request('OPTIONS', TUS, { token: null });
    expect(res.status).toBe(204);
    expect(res.headers.get('tus-version')).toContain('1.0.0');
    expect(res.headers.get('tus-extension')).toMatch(/creation/);
    const { maxUploadBytes } = (await api.get('/sync/v1/account')).json();
    expect(res.headers.get('tus-max-size')).toBe(String(maxUploadBytes));
  });

  it('create → partial PATCH → HEAD → resume → 200 with the new item', async () => {
    const data = randomBytes(300_000);
    const created = await create(data.length, { name: 'resumed.bin', parentId: box.id, modifiedAt: '2024-05-06T07:08:09.000Z' });
    expect(created.status).toBe(201);
    const location = created.headers.get('location')!;
    expect(location).toMatch(/^\/api\/sync\/v1\/uploads\/[^/]+$/);

    const first = await patch(location, 0, data.subarray(0, 120_000));
    expect(first.status).toBe(204);
    expect(first.headers.get('upload-offset')).toBe('120000');
    // Nothing is visible in the folder before the upload completes.
    expect((await api.get(`/sync/v1/items/${box.id}/children`)).json().items.map((i: SyncItem) => i.name)).not.toContain('resumed.bin');

    const state = await head(location);
    expect(state.status).toBe(200);
    expect(state.headers.get('upload-offset')).toBe('120000');
    expect(state.headers.get('upload-length')).toBe(String(data.length));
    expect(state.headers.get('cache-control')).toBe('no-store');

    const wrong = await patch(location, 1000, data.subarray(1000));
    expect(wrong.status).toBe(409);

    const rest = await patch(location, 120_000, data.subarray(120_000));
    expect(rest.status).toBe(200);
    expect(rest.headers.get('upload-offset')).toBe(String(data.length));
    const item = rest.json<SyncItem>();
    expect(schemaErrors('SyncItem', item)).toBe('');
    expect(rest.headers.get('x-synclet-item')).toBe(item.id);
    expect(item).toMatchObject({
      name: 'resumed.bin', parentId: box.id, size: data.length, version: 1, modifiedAt: '2024-05-06T07:08:09.000Z',
      sha256: createHash('sha256').update(data).digest('hex'),
    });
    expect((await api.get(`/sync/v1/items/${item.id}/content`)).body.equals(data)).toBe(true);
    expect((await head(location)).status).toBe(404); // finished uploads are gone
  });

  it('creation-with-upload and empty files complete in the POST (201 + item)', async () => {
    const inline = await create(5, { name: 'inline.txt', parentId: box.id }, Buffer.from('hello'));
    expect(inline.status).toBe(201);
    expect(inline.json()).toMatchObject({ name: 'inline.txt', size: 5 });
    expect(inline.headers.get('x-synclet-item')).toBe(inline.json().id);
    const empty = await create(0, { name: 'empty.txt', parentId: box.id });
    expect(empty.status).toBe(201);
    expect(empty.json()).toMatchObject({ name: 'empty.txt', size: 0 });
  });

  it('name conflicts rename by default; onConflict=fail answers 409 name_conflict at completion', async () => {
    await uploadFile(api, box.id, 'taken.txt', 'one');
    const loc = (await create(3, { name: 'TAKEN.txt', parentId: box.id })).headers.get('location')!;
    expect((await patch(loc, 0, Buffer.from('two'))).json()).toMatchObject({ name: 'TAKEN (2).txt' });
    const failLoc = (await create(5, { name: 'taken.txt', parentId: box.id, onConflict: 'fail' })).headers.get('location')!;
    const conflict = await patch(failLoc, 0, Buffer.from('three'));
    expect(conflict.status).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'name_conflict', item: { name: 'taken.txt' } });
    expect((await head(failLoc)).status).toBe(404); // the part is dropped
  });

  it('validates metadata at creation (invalid_name, unknown parent, bad onConflict)', async () => {
    const noName = await create(1, { parentId: box.id });
    expect(noName.status).toBe(400);
    expect(noName.json().code).toBe('invalid_name');
    expect((await create(1, { name: 'a/b', parentId: box.id })).json().code).toBe('invalid_name');
    const missing = await create(1, { name: 'x.txt', parentId: 'd_00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
    expect(missing.json().code).toBe('not_found');
    expect((await create(1, { name: 'x.txt', parentId: box.id, onConflict: 'replace' })).status).toBe(400);
    expect((await create(1, { name: 'x.txt', parentId: box.id, modifiedAt: 'yesterday' })).status).toBe(400);
  });

  it('replaces an existing file via itemId + ifMatch (success, stale etag, folder, name+itemId)', async () => {
    const file = await uploadFile(api, box.id, 'replace-me.txt', 'original');
    const data = randomBytes(200_000);
    const created = await create(data.length, { itemId: file.id, ifMatch: file.etag, modifiedAt: '2024-05-06T07:08:09.000Z' });
    expect(created.status).toBe(201);
    const location = created.headers.get('location')!;
    expect((await patch(location, 0, data.subarray(0, 80_000))).status).toBe(204);
    const done = await patch(location, 80_000, data.subarray(80_000));
    expect(done.status).toBe(200);
    const item = done.json<SyncItem>();
    expect(schemaErrors('SyncItem', item)).toBe('');
    expect(done.headers.get('x-synclet-item')).toBe(file.id);
    expect(item).toMatchObject({ id: file.id, name: 'replace-me.txt', version: (file.version ?? 1) + 1, size: data.length, modifiedAt: '2024-05-06T07:08:09.000Z' });
    expect((await api.get(`/sync/v1/items/${file.id}/content`)).body.equals(data)).toBe(true);

    // The old etag is stale now: 412 at creation with the current item.
    const stale = await create(1, { itemId: file.id, ifMatch: file.etag });
    expect(stale.status).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'conflict', item: { id: file.id, version: (file.version ?? 1) + 1 } });
    // ifMatch is required with itemId.
    const missing = await create(1, { itemId: file.id });
    expect(missing.status).toBe(428);
    expect(missing.json().code).toBe('precondition_required');
    // A folder is not replaceable; name/parentId/onConflict cannot be combined with itemId.
    expect((await create(1, { itemId: box.id, ifMatch: box.etag })).status).toBe(400);
    const mixed = await create(1, { itemId: file.id, ifMatch: item.etag, name: 'x.txt' });
    expect(mixed.status).toBe(400);
    expect(mixed.json().code).toBe('invalid_request');
    // Etag changes between creation and publish: 412 at completion, the upload is dropped.
    const loc = (await create(3, { itemId: file.id, ifMatch: item.etag })).headers.get('location')!;
    expect((await api.replace(file.id, 'web edit', item.etag)).status).toBe(200);
    const late = await patch(loc, 0, Buffer.from('new'));
    expect(late.status).toBe(412);
    expect(late.json()).toMatchObject({ code: 'conflict' });
    expect((await head(loc)).status).toBe(404);
  });

  it('DELETE terminates an unfinished upload; uploads need authentication', async () => {
    const loc = (await create(10, { name: 'aborted.bin', parentId: box.id })).headers.get('location')!;
    expect((await patch(loc, 0, Buffer.from('12345'))).status).toBe(204);
    expect((await api.request('DELETE', loc, { headers: tusHeaders() })).status).toBe(204);
    expect((await head(loc)).status).toBe(404);
    const anon = await api.request('POST', TUS, { token: null, headers: tusHeaders({ 'upload-length': '1', 'upload-metadata': tusMetadata({ name: 'x' }) }) });
    expect(anon.status).toBe(401);
    expect(anon.json().code).toBe('unauthorized');
  });
});
