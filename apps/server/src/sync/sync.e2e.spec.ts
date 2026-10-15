import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, itIfCaseSensitive, TestContext } from '../../test/context';
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { IndexerService } from '../indexer/indexer.service';

describe('Sync API v1', () => {
  let ctx: TestContext; let token: string; let userId: string;
  const api = (method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string>; body?: Buffer | string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
  });
  afterEach(async () => { await ctx.close(); });

  it('registers a device and returns account + token', async () => {
    const res = await api('POST', '/devices', { payload: { name: 'Mac', platform: 'macos', appVersion: '1.0' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^syd_/);
    expect(res.json().account).toMatchObject({ userId, slug: 'jens', canWrite: true, cursor: '0' });
    expect(res.json().account.organizationId).toMatch(new RegExp(`:${userId}$`));
  });

  it('root item and children with folders first and pagination', async () => {
    expect((await api('GET', '/items/root')).json()).toMatchObject({ id: 'root', parentId: null, kind: 'root', type: 'folder' });
    for (const n of ['b.txt', 'a.txt', 'c.txt']) await api('POST', `/items/upload?parentId=root&name=${n}`, { body: 'x' });
    await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Z' } });
    const p1 = (await api('GET', '/items/root/children?limit=2')).json();
    expect(p1.items[0].type).toBe('folder');
    expect(p1.nextPageToken).toBeTruthy();
    const p2 = (await api('GET', `/items/root/children?limit=2&pageToken=${p1.nextPageToken}`)).json();
    expect([...p1.items, ...p2.items].map((i: { name: string }) => i.name).sort()).toEqual(['Z', 'a.txt', 'b.txt', 'c.txt']);
    expect(p2.nextPageToken).toBeNull();
  });

  it('upload, download with range and etags, replace with If-Match', async () => {
    const up = await api('POST', '/items/upload?parentId=root&name=hello.txt', { body: 'hello world' });
    expect(up.statusCode).toBe(201);
    const item = up.json();
    expect(item).toMatchObject({ kind: 'file', name: 'hello.txt', size: 11, version: 1, etag: 'v1', contentEtag: 'v1', mime: 'text/plain' });
    const dl = await api('GET', `/items/${item.id}/content`);
    expect(dl.body).toBe('hello world');
    expect(dl.headers.etag).toBe('"v1"');
    expect(dl.headers['accept-ranges']).toBe('bytes');
    const part = await api('GET', `/items/${item.id}/content`, { headers: { range: 'bytes=6-' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('world');
    expect(part.headers['content-range']).toBe('bytes 6-10/11');
    expect((await api('GET', `/items/${item.id}/content`, { headers: { range: 'bytes=50-' } })).statusCode).toBe(416);
    expect((await api('GET', `/items/${item.id}/content`, { headers: { 'if-none-match': '"v1"' } })).statusCode).toBe(304);
    expect((await api('PUT', `/items/${item.id}/content`, { body: 'new' })).json().code).toBe('precondition_required');
    const stale = await api('PUT', `/items/${item.id}/content`, { body: 'new', headers: { 'if-match': '"v9"' } });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().item).toMatchObject({ id: item.id, version: 1 });
    const ok = await api('PUT', `/items/${item.id}/content`, { body: 'new', headers: { 'if-match': '"v1"' } });
    expect(ok.json()).toMatchObject({ version: 2, size: 3 });
  });

  it('download token works without Authorization header', async () => {
    const item = (await api('POST', '/items/upload?parentId=root&name=a.pdf', { body: '%PDF' })).json();
    const { url } = (await api('POST', `/items/${item.id}/download-token`)).json();
    const res = await ctx.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''a.pdf");
  });

  it('409 name_conflict carries the existing item; onConflict=rename picks a free name', async () => {
    await api('POST', '/items/upload?parentId=root&name=a.txt', { body: '1' });
    const conflict = await api('POST', '/items/upload?parentId=root&name=A.TXT', { body: '2' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().item.name).toBe('a.txt');
    const renamed = await api('POST', '/items/upload?parentId=root&name=A.TXT&onConflict=rename', { body: '2' });
    expect(renamed.json().name).toBe('A (2).TXT');
  });

  it('patch renames/moves and delete removes; changes reflect everything', async () => {
    const c0 = (await api('GET', '/cursor')).json().cursor;
    const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Docs' } })).json();
    const file = (await api('POST', '/items/upload?parentId=root&name=x.txt', { body: 'x' })).json();
    const moved = await api('PATCH', `/items/${file.id}`, { payload: { name: 'y.txt', parentId: folder.id } });
    expect(moved.json()).toMatchObject({ id: file.id, name: 'y.txt', parentId: folder.id });
    expect((await api('DELETE', `/items/${folder.id}`)).statusCode).toBe(204);
    const page = (await api('GET', `/changes?cursor=${c0}`)).json();
    expect(page.changes).toEqual(expect.arrayContaining([{ op: 'delete', id: folder.id }, { op: 'delete', id: file.id }]));
    expect((await api('GET', `/items/${file.id}`)).statusCode).toBe(404);
  });

  it('changes include external edits picked up by the indexer', async () => {
    const c0 = (await api('GET', '/cursor')).json().cursor;
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'external.md'), '# hi');
    await ctx.app.get(IndexerService).fullScan({ id: userId, username: 'jens' });
    const page = (await api('GET', `/changes?cursor=${c0}`)).json();
    expect(page.changes).toEqual([expect.objectContaining({ op: 'upsert', item: expect.objectContaining({ name: 'external.md', parentId: 'root' }) })]);
  });

  it('410 for expired cursors, 400 for unknown ids, 404 for other users items', async () => {
    expect((await api('GET', '/changes?cursor=999')).json().code).toBe('cursor_expired');
    expect((await api('GET', '/items/bogus')).statusCode).toBe(400);
    expect((await api('GET', '/items/f_3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab')).statusCode).toBe(404);
  });

  it('children of a file is invalid_request', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=a.txt', { body: '1' })).json();
    expect((await api('GET', `/items/${f.id}/children`)).json().code).toBe('invalid_request');
  });

  it('accepts X-Buro-Modified-At as alias', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=t.txt', { body: '1', headers: { 'x-buro-modified-at': '2023-01-02T03:04:05.000Z' } })).json();
    expect(f.modifiedAt).toBe('2023-01-02T03:04:05.000Z');
  });

  it('changes report purged items as deletes using the journal item type', async () => {
    const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Gone' } })).json();
    const file = (await api('POST', `/items/upload?parentId=${folder.id}&name=x.txt`, { body: 'x' })).json();
    const c0 = (await api('GET', '/cursor')).json().cursor;
    await api('DELETE', `/items/${folder.id}`);
    // Tombstones are purged after a day while the journal lives for 30 days.
    expect(await ctx.app.get(ItemStore).purgeTombstones(new Date(Date.now() + 60_000))).toBe(2);
    const page = (await api('GET', `/changes?cursor=${c0}`)).json();
    expect(page.changes).toEqual(expect.arrayContaining([{ op: 'delete', id: folder.id }, { op: 'delete', id: file.id }]));
    expect(page.changes).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    // The full history from 0 also degrades purged upserts to deletes.
    const all = (await api('GET', '/changes?cursor=0&limit=abc')).json();
    expect(all.changes.every((c: { op: string }) => c.op === 'delete')).toBe(true);
  });

  it('changes pages with limit and hasMore', async () => {
    for (const n of ['1.txt', '2.txt', '3.txt']) await api('POST', `/items/upload?parentId=root&name=${n}`, { body: n });
    const p1 = (await api('GET', '/changes?cursor=0&limit=2')).json();
    expect(p1.changes).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = (await api('GET', `/changes?cursor=${p1.cursor}&limit=0`)).json(); // 0 => default
    expect(p2.changes.map((c: { item: { name: string } }) => c.item.name)).toEqual(['3.txt']);
    expect(p2.hasMore).toBe(false);
    expect(p2.cursor).toBe((await api('GET', '/cursor')).json().cursor);
  });

  it('folder etags survive an ancestor move (rewritePrefix) but change with the folder itself', async () => {
    const outer = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Outer' } })).json();
    const inner = (await api('POST', '/items', { payload: { parentId: outer.id, type: 'folder', name: 'Inner' } })).json();
    const target = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Target' } })).json();
    expect(inner.etag).toMatch(/^t/);
    const before = await ctx.prisma.item.findUniqueOrThrow({ where: { id: inner.id.slice(2) } });
    await new Promise((r) => setTimeout(r, 20));
    expect((await api('PATCH', `/items/${outer.id}`, { payload: { parentId: target.id }, headers: { 'if-match': `"${outer.etag}"` } })).statusCode).toBe(200);
    const after = await ctx.prisma.item.findUniqueOrThrow({ where: { id: inner.id.slice(2) } });
    expect(after.updatedAt.getTime()).not.toBe(before.updatedAt.getTime()); // bumped without a journal entry
    expect((await api('GET', `/items/${inner.id}`)).json().etag).toBe(inner.etag);
    const renamed = await api('PATCH', `/items/${inner.id}`, { payload: { name: 'Inner2' }, headers: { 'if-match': `"${inner.etag}"` } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().etag).not.toBe(inner.etag);
    // A client still holding the pre-rename etag gets a real conflict with the current item.
    const stale = await api('PATCH', `/items/${inner.id}`, { payload: { name: 'Inner3' }, headers: { 'if-match': `"${inner.etag}"` } });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'conflict', item: { id: inner.id, name: 'Inner2', etag: renamed.json().etag } });
    expect((await api('PATCH', `/items/${inner.id}`, { payload: { name: 'Inner3' }, headers: { 'if-match': '*' } })).statusCode).toBe(200);
  });

  it('file PATCH honours If-Match and refuses root', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=a.txt', { body: '1' })).json();
    expect((await api('PATCH', `/items/${f.id}`, { payload: { name: 'b.txt' }, headers: { 'if-match': '"v7"' } })).statusCode).toBe(412);
    expect((await api('PATCH', `/items/${f.id}`, { payload: { name: 'b.txt' }, headers: { 'if-match': 'v1' } })).json().name).toBe('b.txt');
    expect((await api('PATCH', '/items/root', { payload: { name: 'x' } })).json().code).toBe('forbidden');
    expect((await api('DELETE', '/items/root')).json().code).toBe('forbidden');
  });

  itIfCaseSensitive('PATCH with the display name keeps the stored name, unless only the display name is free at the target', async () => {
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'a.txt'), '1');
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'A.txt'), '2');
    await ctx.app.get(IndexerService).fullScan({ id: userId, username: 'jens' });
    const kids = (await api('GET', '/items/root/children')).json().items as { id: string; name: string }[];
    const dup = kids.find((k) => / \(2\)\.txt$/.test(k.name))!;
    const storedName = (await ctx.prisma.item.findUniqueOrThrow({ where: { id: dup.id.slice(2) } })).name;
    const noop = await api('PATCH', `/items/${dup.id}`, { payload: { name: dup.name } });
    expect(noop.json().name).toBe(dup.name);
    expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: dup.id.slice(2) } })).name).toBe(storedName);
    const d = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'D' } })).json();
    await api('POST', `/items/upload?parentId=${d.id}&name=${storedName}`, { body: 'x' });
    const moved = await api('PATCH', `/items/${dup.id}`, { payload: { name: dup.name, parentId: d.id } });
    expect(moved.json()).toMatchObject({ name: dup.name, parentId: d.id });
  });

  it('content: suffix ranges, If-None-Match lists, safe headers, empty files', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=page.html', { body: '<script>1</script>' })).json();
    const tail = await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=-9' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.body).toBe('1</script>'.slice(1));
    expect(tail.headers['content-range']).toBe('bytes 9-17/18');
    const full = await api('GET', `/items/${f.id}/content`);
    expect(full.headers['content-type']).toContain('text/html');
    expect(full.headers['content-length']).toBe('18');
    expect(full.headers['x-content-type-options']).toBe('nosniff');
    expect(full.headers['content-security-policy']).toContain('sandbox');
    expect(full.headers['cache-control']).toBe('private, no-store');
    expect(full.headers['content-disposition']).toBeUndefined();
    expect((await api('GET', `/items/${f.id}/content`, { headers: { 'if-none-match': 'W/"v0", "v1"' } })).statusCode).toBe(304);
    expect((await api('GET', `/items/${f.id}/content`, { headers: { 'if-none-match': '"v0"' } })).statusCode).toBe(200);
    const bad = await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=18-' } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */18');
    expect(bad.json().code).toBe('range_not_satisfiable');
    expect((await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=0-1,4-5' } })).statusCode).toBe(200);

    const empty = await api('POST', '/items/upload?parentId=root&name=empty.bin', { body: '' });
    expect(empty.statusCode).toBe(201);
    expect(empty.json()).toMatchObject({ size: 0, mime: 'application/octet-stream' });
    const dl = await api('GET', `/items/${empty.json().id}/content`);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('');
    expect((await api('GET', '/items/root/content')).json().code).toBe('invalid_request');
  });

  it('download tokens: attachment name encoding, bound to the item', async () => {
    const a = (await api('POST', `/items/upload?parentId=root&name=${encodeURIComponent("Über (1)'s.pdf")}`, { body: '%PDF' })).json();
    const b = (await api('POST', '/items/upload?parentId=root&name=b.pdf', { body: '%PDF' })).json();
    const { url } = (await api('POST', `/items/${a.id}/download-token`)).json();
    const res = await ctx.app.inject({ method: 'GET', url });
    expect(res.headers['content-disposition']).toBe(`attachment; filename="_ber (1)'s.pdf"; filename*=UTF-8''%C3%9Cber%20%281%29%27s.pdf`);
    expect(res.headers['content-security-policy']).toBeUndefined(); // PDFs stay viewable inline
    const dt = new URL(url, 'http://x').searchParams.get('dt')!;
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sync/v1/items/${b.id}/content?dt=${dt}` })).statusCode).toBe(401);
    const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'F' } })).json();
    expect((await api('POST', `/items/${folder.id}/download-token`)).json().code).toBe('invalid_request');
  });

  it('raw bodies must be octet-stream; oversized declared length is 413', async () => {
    const json = await api('POST', '/items/upload?parentId=root&name=j.txt', { payload: { a: 1 } });
    expect(json.statusCode).toBe(400);
    expect(json.json().code).toBe('invalid_request');
    expect((await api('POST', '/items/upload?parentId=root&name=j.txt&onConflict=overwrite', { body: 'x' })).json().code).toBe('invalid_request');
    expect((await api('GET', '/items/root/children')).json().items).toEqual([]);
    const big = await api('POST', '/items/upload?parentId=root&name=big.bin', { body: 'x', headers: { 'content-length': String(ctx.config.maxUploadBytes + 1) } });
    expect(big.statusCode).toBe(413);
  });

  it('children: invalid page tokens are rejected; limit is clamped', async () => {
    expect((await api('GET', '/items/root/children?pageToken=abc')).json().code).toBe('invalid_request');
    expect((await api('GET', '/items/root/children?pageToken=2:3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab')).json().code).toBe('invalid_request');
    for (const n of ['a', 'b']) await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: n } });
    const p = (await api('GET', '/items/root/children?limit=-5')).json();
    expect(p.items).toHaveLength(1);
    expect(p.nextPageToken).toMatch(/^0:/);
    expect(typeof p.cursor).toBe('string');
  });

  it('devices: list marks current, revoke current, revoked token is rejected', async () => {
    const reg = (await api('POST', '/devices', { payload: { name: 'Mac', platform: 'macos', appVersion: '1.0' } })).json();
    const dev = { authorization: `Bearer ${reg.token}` };
    const list = await ctx.app.inject({ method: 'GET', url: '/api/sync/v1/devices', headers: dev });
    expect(list.json()).toEqual([expect.objectContaining({ id: reg.device.id, current: true })]);
    expect((await ctx.app.inject({ method: 'PUT', url: '/api/sync/v1/devices/current/push', headers: dev, payload: { token: 'ab', environment: 'sandbox' } })).statusCode).toBe(204);
    expect((await api('DELETE', '/devices/current')).json().code).toBe('invalid_request'); // JWT, not a device token
    expect((await api('DELETE', '/devices/not-a-uuid')).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/sync/v1/devices/current', headers: dev })).statusCode).toBe(204);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/sync/v1/account', headers: dev });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('device_revoked');
    expect((await api('GET', '/devices')).json()).toEqual([]);
  });

  it('account reports usage and limits', async () => {
    await api('POST', '/items/upload?parentId=root&name=a.bin', { body: '12345' });
    const acc = (await api('GET', '/account')).json();
    expect(acc).toMatchObject({ slug: 'jens', displayName: 'Jens', usedBytes: 5, maxUploadBytes: ctx.config.maxUploadBytes, organizationName: 'Synclet' });
    expect(acc.cursor).toBe((await api('GET', '/cursor')).json().cursor);
  });
  it('PUT content with If-Match: * replaces any current version, but never an unindexed host edit', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=star.txt', { body: 'one' })).json();
    expect((await api('PUT', `/items/${f.id}/content`, { body: 'two', headers: { 'if-match': '"v1"' } })).json()).toMatchObject({ version: 2 });
    const any = await api('PUT', `/items/${f.id}/content`, { body: 'three', headers: { 'if-match': '*' } });
    expect(any.statusCode).toBe(200);
    expect(any.json()).toMatchObject({ version: 3, size: 5 });
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'star.txt'), 'edited on host');
    const host = await api('PUT', `/items/${f.id}/content`, { body: 'four', headers: { 'if-match': '*' } });
    expect(host.statusCode).toBe(412);
    expect(host.json().item).toMatchObject({ version: 4, size: 14 });
  });

  it('unsupported Content-Type on raw upload routes is a Sync-format 400; elsewhere 415 stays', async () => {
    const up = await api('POST', '/items/upload?parentId=root&name=t.txt', { payload: 'hello', headers: { 'content-type': 'image/png' } });
    expect(up.statusCode).toBe(400);
    expect(up.json()).toMatchObject({ statusCode: 400, code: 'invalid_request' });
    const f = (await api('POST', '/items/upload?parentId=root&name=t.txt', { body: 'x' })).json();
    const put = await api('PUT', `/items/${f.id}/content`, { payload: 'hello', headers: { 'content-type': 'image/png', 'if-match': '"v1"' } });
    expect(put.statusCode).toBe(400);
    expect(put.json().code).toBe('invalid_request');
    expect((await api('GET', `/items/${f.id}/content`)).body).toBe('x');
    const other = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'image/png' }, payload: 'x' });
    expect(other.statusCode).toBe(415);
    const otherSync = await api('POST', '/items', { payload: 'x', headers: { 'content-type': 'image/png' } });
    expect(otherSync.statusCode).toBe(415);
  });

  it('content honours If-Range: a stale validator or an unindexed host edit sends the full file', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=r.txt', { body: 'hello world' })).json();
    const resumed = await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=6-', 'if-range': '"v1"' } });
    expect(resumed.statusCode).toBe(206);
    expect(resumed.body).toBe('world');
    const lm = resumed.headers['last-modified'] as string;
    expect((await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=6-', 'if-range': lm } })).statusCode).toBe(206);
    const stale = await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=6-', 'if-range': '"v0"' } });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toBe('hello world');
    expect((await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=6-', 'if-range': 'W/"v1"' } })).statusCode).toBe(200);
    // Edited on the host, not indexed yet: the row still says v1, but the bytes changed.
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'r.txt'), 'HELLO WORLD!');
    const changed = await api('GET', `/items/${f.id}/content`, { headers: { range: 'bytes=6-', 'if-range': '"v1"' } });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe('HELLO WORLD!');
  });

  it('content never follows a symlink swapped in after the path check (O_NOFOLLOW)', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=s.txt', { body: 'mine' })).json();
    const outside = path.join(ctx.config.metaRoot, 'secret.txt');
    await writeFile(outside, 'secret');
    const link = path.join(ctx.config.dataRoot, 'jens', 'link.txt');
    await symlink(outside, link);
    const files = ctx.app.get(FilesService);
    const orig = files.openRead.bind(files);
    jest.spyOn(files, 'openRead').mockImplementation(async (u, id) => ({ ...(await orig(u, id)), abs: link }));
    const res = await api('GET', `/items/${f.id}/content`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('secret');
  });
});
