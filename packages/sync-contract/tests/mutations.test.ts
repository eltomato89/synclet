import type { SyncItem } from '@synclet/shared';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

/** Sends only headers with a (too large) declared Content-Length and reads the early answer. */
/** Sends the headers and one byte of a body declared as `length` bytes; the rest never comes. */
function declaredLengthRequest(method: string, path: string, length: string, headers: Record<string, string>): Promise<{ status: number; body: string; contentType: string; ms: number }> {
  const started = Date.now();
  const url = new URL(path, ctx.baseUrl);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/octet-stream', 'content-length': length, ...headers },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body, contentType: String(res.headers['content-type'] ?? ''), ms: Date.now() - started });
        req.destroy();
      });
    });
    req.on('error', reject);
    // Without an early answer the request would wait for a body that never comes.
    req.setTimeout(15_000, () => req.destroy(new Error(`no response to ${method} ${path} within 15 s`)));
    req.write('x'); // a first byte, so the server starts processing; the rest never comes
  });
}

describe('PUT content (replace)', () => {
  it('requires If-Match: 428 precondition_required without it', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    const res = await api.replace(f.id, 'two');
    expect(res.status).toBe(428);
    expect(res.json()).toMatchObject({ statusCode: 428, code: 'precondition_required' });
    expect((await api.get(`/sync/v1/items/${f.id}/content`)).text()).toBe('one');
  });

  it('replaces with the current contentEtag: 200, version + 1, new etag and hash', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    const res = await api.replace(f.id, 'two!', `"${f.contentEtag}"`);
    expect(res.status).toBe(200);
    const item = res.json<SyncItem>();
    expect(schemaErrors('SyncItem', item)).toBe('');
    expect(item).toMatchObject({ id: f.id, version: 2, etag: 'v2', contentEtag: 'v2', size: 4, sha256: createHash('sha256').update('two!').digest('hex') });
    expect((await api.get(`/sync/v1/items/${f.id}/content`)).text()).toBe('two!');
    // Unquoted etags are accepted too.
    expect((await api.replace(f.id, 'three', 'v2')).json().version).toBe(3);
  });

  it('a stale If-Match is 412 conflict carrying the current item; nothing is written', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    await api.replace(f.id, 'two', '"v1"');
    for (const stale of ['"v1"', '"bogus"']) {
      const res = await api.replace(f.id, 'mine', stale);
      expect(res.status, stale).toBe(412);
      const body = res.json();
      expect(body).toMatchObject({ statusCode: 412, code: 'conflict', item: { id: f.id, version: 2, contentEtag: 'v2' } });
      expect(schemaErrors('Error', body)).toBe('');
    }
    expect((await api.get(`/sync/v1/items/${f.id}/content`)).text()).toBe('two');
  });

  it('If-Match: * replaces whatever version is current', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    const res = await api.replace(f.id, 'any', '*');
    expect(res.status).toBe(200);
    expect(res.json().version).toBe(2);
  });

  it('X-Synclet-Modified-At (or X-Buro-Modified-At) sets modifiedAt; empty bodies are allowed', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    const at = '2024-05-06T07:08:09.000Z';
    const res = await api.replace(f.id, '', '"v1"', { 'x-synclet-modified-at': at });
    expect(res.json()).toMatchObject({ size: 0, version: 2, modifiedAt: at });
    const buro = await api.upload(box.id, 'buro.txt', 'b', { headers: { 'x-buro-modified-at': '2023-01-02T03:04:05.000Z' } });
    expect(buro.json().modifiedAt).toBe('2023-01-02T03:04:05.000Z');
  });

  it('raw bodies must be application/octet-stream (400 invalid_request otherwise)', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    const res = await api.request('PUT', `/sync/v1/items/${f.id}/content`, { body: '{"a":1}', headers: { 'content-type': 'application/json', 'if-match': '"v1"' } });
    expect(res.status).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    const up = await api.request('POST', `/sync/v1/items/upload?parentId=${box.id}&name=x.txt`, { body: 'x', headers: { 'content-type': 'text/plain' } });
    expect(up.status).toBe(400);
    expect(up.json().code).toBe('invalid_request');
  });

  it('PUT on a folder is 400; on an unknown file 404', async () => {
    const box = await scratchFolder(api, ctx, 'put');
    expect((await api.replace(box.id, 'x', '*')).status).toBe(400);
    expect((await api.replace('f_00000000-0000-4000-8000-000000000000', 'x', '*')).status).toBe(404);
  });

  it('a declared Content-Length above maxUploadBytes is 413 too_large', async () => {
    const { maxUploadBytes } = (await api.get('/sync/v1/account')).json();
    const box = await scratchFolder(api, ctx, 'put');
    const f = await uploadFile(api, box.id, 'a.txt', 'one');
    // The limit is checked against the declared length before the body is read – by the server,
    // or by a reverse proxy in front of it with the same limit (the bundled Caddy), whose 413 may
    // not be JSON.
    const declared = String(maxUploadBytes + 1);
    for (const [method, path, extra] of [
      ['POST', `/api/sync/v1/items/upload?parentId=${box.id}&name=big.bin`, {}],
      ['PUT', `/api/sync/v1/items/${f.id}/content`, { 'if-match': '*' }],
    ] as const) {
      const res = await declaredLengthRequest(method, path, declared, extra);
      expect(res.status, method).toBe(413);
      expect(res.ms, `${method}: 413 only after ${res.ms} ms`).toBeLessThan(5_000);
      if (res.contentType.includes('application/json')) expect(JSON.parse(res.body).code).toBe('too_large');
    }
  });
});

describe('upload and folder creation conflicts', () => {
  it('a taken name is 409 name_conflict with the existing item (case-insensitive)', async () => {
    const box = await scratchFolder(api, ctx, 'conflict');
    const existing = await uploadFile(api, box.id, 'Report.txt', 'one');
    for (const name of ['Report.txt', 'report.TXT']) {
      const res = await api.upload(box.id, name, 'two');
      expect(res.status, name).toBe(409);
      expect(res.json()).toMatchObject({ statusCode: 409, code: 'name_conflict', item: { id: existing.id, name: 'Report.txt' } });
    }
    expect((await api.upload(box.id, 'Report.txt', 'two', { onConflict: 'fail' })).status).toBe(409);
  });

  it('onConflict=rename picks "<base> (n).<ext>" for files and "<name> (n)" for folders', async () => {
    const box = await scratchFolder(api, ctx, 'conflict');
    await uploadFile(api, box.id, 'a.tar.gz', '1');
    expect((await api.upload(box.id, 'a.tar.gz', '2', { onConflict: 'rename' })).json()).toMatchObject({ name: 'a.tar (2).gz' });
    expect((await api.upload(box.id, 'A.TAR.GZ', '3', { onConflict: 'rename' })).json()).toMatchObject({ name: 'A.TAR (3).GZ' });
    await uploadFile(api, box.id, '.env', 'x');
    expect((await api.upload(box.id, '.env', 'y', { onConflict: 'rename' })).json().name).toBe('.env (2)');
    const f1 = await api.mkdir(box.id, 'Docs');
    expect(f1.status).toBe(201);
    const dup = await api.mkdir(box.id, 'docs');
    expect(dup.status).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'name_conflict', item: { id: f1.json().id } });
    expect((await api.mkdir(box.id, 'Docs', 'rename')).json().name).toBe('Docs (2)');
  });

  it('files and folders share one namespace', async () => {
    const box = await scratchFolder(api, ctx, 'conflict');
    await api.mkdir(box.id, 'x.pdf');
    const res = await api.upload(box.id, 'X.pdf', 'pdf');
    expect(res.status).toBe(409);
    expect(res.json().item).toMatchObject({ type: 'folder', name: 'x.pdf' });
  });

  it('invalid names are 400 invalid_name', async () => {
    const box = await scratchFolder(api, ctx, 'names');
    const bad = ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'tab\tname', 'trailing.', 'trailing ', 'CON', 'lpt1.txt',
      '.DS_Store', 'Thumbs.db', 'desktop.ini', '~$draft.docx', '._resource', 'x'.repeat(256), 'ü'.repeat(128)];
    for (const name of bad) {
      const res = await api.upload(box.id, name, 'x');
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.json().code, JSON.stringify(name)).toBe('invalid_name');
      const dir = await api.mkdir(box.id, name);
      expect(dir.status, JSON.stringify(name)).toBe(400);
    }
    // 255 bytes are fine; names are stored NFC-normalized.
    expect((await api.upload(box.id, 'x'.repeat(255), 'x')).status).toBe(201);
    expect((await api.upload(box.id, 'Café.txt', 'x')).json().name).toBe('Café.txt');
  });

  it('bad parameters: unknown parent 404, file as parent 400, bad onConflict 400', async () => {
    const box = await scratchFolder(api, ctx, 'params');
    const file = await uploadFile(api, box.id, 'p.txt', 'p');
    expect((await api.upload('d_00000000-0000-4000-8000-000000000000', 'a.txt', 'a')).status).toBe(404);
    expect((await api.upload(file.id, 'a.txt', 'a')).json().code).toBe('invalid_request');
    const q = await api.request('POST', `/sync/v1/items/upload?parentId=${box.id}&name=a.txt&onConflict=replace`, { body: 'a', headers: { 'content-type': 'application/octet-stream' } });
    expect(q.status).toBe(400);
    expect((await api.post('/sync/v1/items', { parentId: box.id, type: 'file', name: 'n' })).json().code).toBe('invalid_request');
    expect((await api.mkdir(file.id, 'sub')).status).toBe(400);
  });

  it('upload without parentId goes to the root (cleaned up right away)', async () => {
    const name = `contract-root-${Date.now()}.txt`;
    const res = await api.request('POST', `/sync/v1/items/upload?name=${encodeURIComponent(name)}`, { body: 'r', headers: { 'content-type': 'application/octet-stream' } });
    expect(res.status).toBe(201);
    expect(res.json().parentId).toBe('root');
    // Move it into the suite folder so the suite teardown removes it.
    expect((await api.patch(`/sync/v1/items/${res.json().id}`, { parentId: ctx.folderId })).status).toBe(200);
  });
});

describe('PATCH and DELETE', () => {
  it('renames and moves files and folders; ids never change', async () => {
    const box = await scratchFolder(api, ctx, 'patch');
    const a = (await api.mkdir(box.id, 'A')).json<SyncItem>();
    const b = (await api.mkdir(box.id, 'B')).json<SyncItem>();
    const f = await uploadFile(api, a.id, 'f.txt', 'f');
    const renamed = await api.patch(`/sync/v1/items/${f.id}`, { name: 'g.txt' });
    expect(renamed.status).toBe(200);
    expect(renamed.json()).toMatchObject({ id: f.id, name: 'g.txt', parentId: a.id, version: 1 });
    const moved = await api.patch(`/sync/v1/items/${f.id}`, { parentId: b.id, name: 'h.txt' });
    expect(moved.json()).toMatchObject({ id: f.id, name: 'h.txt', parentId: b.id });
    const folderMoved = await api.patch(`/sync/v1/items/${a.id}`, { parentId: b.id });
    expect(folderMoved.json()).toMatchObject({ id: a.id, parentId: b.id, name: 'A' });
    expect(schemaErrors('SyncItem', folderMoved.json())).toBe('');
  });

  it('If-Match is optional; a stale one is 412 conflict with the current item', async () => {
    const box = await scratchFolder(api, ctx, 'patch');
    const f = await uploadFile(api, box.id, 'f.txt', 'f');
    expect((await api.patch(`/sync/v1/items/${f.id}`, { name: 'g.txt' }, { headers: { 'if-match': `"${f.etag}"` } })).status).toBe(200);
    await api.replace(f.id, 'f2', '"v1"');
    const stale = await api.patch(`/sync/v1/items/${f.id}`, { name: 'h.txt' }, { headers: { 'if-match': '"v1"' } });
    expect(stale.status).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'conflict', item: { id: f.id, name: 'g.txt', etag: 'v2' } });
    // Folders: the etag a client was served is what If-Match compares against.
    const folder = (await api.get(`/sync/v1/items/${box.id}`)).json<SyncItem>();
    const ok = await api.patch(`/sync/v1/items/${box.id}`, { name: `${box.name}-x` }, { headers: { 'if-match': folder.etag } });
    expect(ok.status).toBe(200);
    expect(ok.json().etag).not.toBe(folder.etag);
    const again = await api.patch(`/sync/v1/items/${box.id}`, { name: `${box.name}-y` }, { headers: { 'if-match': folder.etag } });
    expect(again.status).toBe(412);
    expect((await api.patch(`/sync/v1/items/${box.id}`, { name: `${box.name}-z` }, { headers: { 'if-match': '*' } })).status).toBe(200);
  });

  it('a folder etag survives changes inside it and moves of its ancestors', async () => {
    const box = await scratchFolder(api, ctx, 'etag');
    const outer = (await api.mkdir(box.id, 'outer')).json<SyncItem>();
    const inner = (await api.mkdir(outer.id, 'inner')).json<SyncItem>();
    const target = (await api.mkdir(box.id, 'target')).json<SyncItem>();
    const before = (await api.get(`/sync/v1/items/${inner.id}`)).json<SyncItem>();
    await api.patch(`/sync/v1/items/${outer.id}`, { parentId: target.id });
    const after = (await api.get(`/sync/v1/items/${inner.id}`)).json<SyncItem>();
    expect(after.etag).toBe(before.etag);
    expect((await api.patch(`/sync/v1/items/${inner.id}`, { name: 'inner2' }, { headers: { 'if-match': `"${before.etag}"` } })).status).toBe(200);
  });

  it('PATCH with the current name is a no-op (200, unchanged)', async () => {
    const box = await scratchFolder(api, ctx, 'patch');
    const f = await uploadFile(api, box.id, 'same.txt', 's');
    const res = await api.patch(`/sync/v1/items/${f.id}`, { name: 'same.txt' });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual(f);
    expect((await api.patch(`/sync/v1/items/${f.id}`, {})).json()).toEqual(f);
  });

  it('case-only renames are allowed (the item does not collide with itself)', async () => {
    const box = await scratchFolder(api, ctx, 'patch');
    const f = await uploadFile(api, box.id, 'case.txt', 'c');
    expect((await api.patch(`/sync/v1/items/${f.id}`, { name: 'CASE.txt' })).json().name).toBe('CASE.txt');
  });

  it('conflicts and invalid moves: 409 name_conflict (no rename), 400 invalid_move, 400 invalid_name', async () => {
    const box = await scratchFolder(api, ctx, 'patch');
    const a = (await api.mkdir(box.id, 'A')).json<SyncItem>();
    const child = (await api.mkdir(a.id, 'child')).json<SyncItem>();
    const f = await uploadFile(api, box.id, 'f.txt', 'f');
    await uploadFile(api, box.id, 'g.txt', 'g');
    const taken = await api.patch(`/sync/v1/items/${f.id}`, { name: 'G.TXT' });
    expect(taken.status).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'name_conflict', item: { name: 'g.txt' } });
    for (const parentId of [a.id, child.id]) {
      const res = await api.patch(`/sync/v1/items/${a.id}`, { parentId });
      expect(res.status).toBe(400);
      expect(res.json().code).toBe('invalid_move');
    }
    expect((await api.patch(`/sync/v1/items/${f.id}`, { name: 'bad/name' })).json().code).toBe('invalid_name');
    expect((await api.patch(`/sync/v1/items/${f.id}`, { parentId: f.id })).json().code).toBe('invalid_request');
    expect((await api.patch(`/sync/v1/items/${f.id}`, { parentId: 'd_00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('root cannot be changed or deleted: 403 forbidden', async () => {
    const p = await api.patch('/sync/v1/items/root', { name: 'x' });
    expect(p.status).toBe(403);
    expect(p.json().code).toBe('forbidden');
    expect((await api.del('/sync/v1/items/root')).status).toBe(403);
  });

  it('DELETE moves to the trash: 204, then 404 for the item and its children', async () => {
    const box = await scratchFolder(api, ctx, 'delete');
    const f = await uploadFile(api, box.id, 'f.txt', 'f');
    expect((await api.del(`/sync/v1/items/${box.id}`)).status).toBe(204);
    expect((await api.get(`/sync/v1/items/${box.id}`)).status).toBe(404);
    expect((await api.get(`/sync/v1/items/${f.id}`)).status).toBe(404);
    expect((await api.del(`/sync/v1/items/${box.id}`)).status).toBe(404);
    const trash = (await api.get('/trash')).json();
    const entry = trash.find((e: { itemId: string }) => e.itemId === box.id);
    expect(entry).toMatchObject({ type: 'folder', name: box.name, itemCount: 2 });
    expect(schemaErrors('TrashEntry', entry)).toBe('');
    // Restore brings the original ids back.
    let restored;
    for (let i = 0; i < 20; i++) {
      restored = await api.post(`/trash/${entry.id}/restore`);
      if (restored.status !== 409) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(restored!.status).toBe(200);
    expect(schemaErrors('RestoreResult', restored!.json())).toBe('');
    expect(restored!.json().item).toMatchObject({ id: box.id, name: box.name });
    expect((await api.get(`/sync/v1/items/${f.id}`)).json()).toMatchObject({ id: f.id, parentId: box.id });
  });
});
