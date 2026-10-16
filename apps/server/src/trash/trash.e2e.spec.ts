import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';
import { FilesService } from '../files/files.service';

describe('Trash API', () => {
  let ctx: TestContext; let token: string;
  const req = (method: string, url: string, opts: { payload?: unknown; body?: string; auth?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url,
      headers: { authorization: `Bearer ${opts.auth ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const sync = (method: string, url: string, opts: { payload?: unknown; body?: string; auth?: string } = {}) => req(method, `/api/sync/v1${url}`, opts);
  const settle = () => ctx.app.get(FilesService).pendingTrash();

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken;
  });
  afterEach(async () => { await ctx.close(); });

  async function folderWithFiles() {
    const folder = (await sync('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Fotos' } })).json();
    const sub = (await sync('POST', '/items', { payload: { parentId: folder.id, type: 'folder', name: '2026' } })).json();
    const f1 = (await sync('POST', `/items/upload?parentId=${folder.id}&name=a.jpg`, { body: 'AAAA' })).json();
    const f2 = (await sync('POST', `/items/upload?parentId=${sub.id}&name=b.jpg`, { body: 'BBBBBB' })).json();
    return { folder, sub, f1, f2 };
  }

  it('lists, restores with original ids and journals upserts', async () => {
    const { folder, sub, f1, f2 } = await folderWithFiles();
    expect((await sync('DELETE', `/items/${folder.id}`)).statusCode).toBe(204);
    await settle();
    const list = await req('GET', '/api/trash');
    expect(list.statusCode).toBe(200);
    const [entry] = list.json();
    expect(entry).toMatchObject({ itemId: folder.id, type: 'folder', name: 'Fotos', originalPath: 'Fotos', size: 10, itemCount: 4 });
    expect(new Date(entry.expiresAt).getTime() - new Date(entry.deletedAt).getTime()).toBe(30 * 24 * 3600 * 1000);
    for (const it of [folder, f1]) expect((await sync('GET', `/items/${it.id}`)).statusCode).toBe(404);

    const cursor = (await sync('GET', '/cursor')).json().cursor;
    const res = await req('POST', `/api/trash/${entry.id}/restore`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restoredTo: 'Fotos', renamed: false, item: { id: folder.id, name: 'Fotos', parentId: 'root' } });
    for (const it of [folder, sub, f1, f2]) expect((await sync('GET', `/items/${it.id}`)).statusCode).toBe(200);
    expect((await sync('GET', `/items/${f1.id}/content`)).body).toBe('AAAA');
    expect((await sync('GET', `/items/${f2.id}/content`)).body).toBe('BBBBBB');
    expect(existsSync(path.join(ctx.config.metaRoot, 'trash', entry.id))).toBe(false);
    const changes = (await sync('GET', `/changes?cursor=${cursor}`)).json();
    const upserts = changes.changes.filter((c: { op: string }) => c.op === 'upsert').map((c: { item: { id: string } }) => c.item.id).sort();
    expect(upserts).toEqual([folder.id, sub.id, f1.id, f2.id].sort());
    expect((await req('GET', '/api/trash')).json()).toEqual([]);
  });

  it('restore with a taken name renames and overwrites nothing', async () => {
    const f = (await sync('POST', '/items/upload?parentId=root&name=X', { body: 'old' })).json();
    await sync('DELETE', `/items/${f.id}`);
    await settle();
    await sync('POST', '/items/upload?parentId=root&name=X', { body: 'new' });
    const [entry] = (await req('GET', '/api/trash')).json();
    const res = (await req('POST', `/api/trash/${entry.id}/restore`)).json();
    expect(res).toMatchObject({ renamed: true, restoredTo: 'X (2)', item: { id: f.id, name: 'X (2)' } });
    const root = path.join(ctx.config.dataRoot, 'jens');
    expect((await readdir(root)).sort()).toEqual(['X', 'X (2)']);
  });

  it('delete forever, empty, and 404 for other users and unknown ids', async () => {
    const a = (await sync('POST', '/items/upload?parentId=root&name=a.txt', { body: 'a' })).json();
    const b = (await sync('POST', '/items/upload?parentId=root&name=b.txt', { body: 'b' })).json();
    const c = (await sync('POST', '/items/upload?parentId=root&name=c.txt', { body: 'c' })).json();
    for (const it of [a, b, c]) await sync('DELETE', `/items/${it.id}`);
    await settle();
    const entries = (await req('GET', '/api/trash')).json();
    expect(entries.map((e: { name: string }) => e.name)).toEqual(['c.txt', 'b.txt', 'a.txt']); // newest first

    // A second user (created by the admin) sees nothing and gets 404 on every route.
    const created = await req('POST', '/api/admin/users', { payload: { username: 'eve', displayName: 'Eve', password: 'another long password' } });
    expect(created.statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'eve', password: 'another long password' } });
    const eve = login.json().accessToken;
    const id = entries[0].id;
    expect((await req('GET', '/api/trash', { auth: eve })).json()).toEqual([]);
    expect((await req('POST', `/api/trash/${id}/restore`, { auth: eve })).statusCode).toBe(404);
    expect((await req('DELETE', `/api/trash/${id}`, { auth: eve })).statusCode).toBe(404);
    expect((await req('DELETE', '/api/trash', { auth: eve })).json()).toEqual({ removed: 0 });
    expect((await req('POST', '/api/trash/nope/restore')).statusCode).toBe(404);
    expect((await req('GET', '/api/trash', { auth: 'garbage' })).statusCode).toBe(401);

    const del = await req('DELETE', `/api/trash/${id}`);
    expect(del.statusCode).toBe(204);
    expect(existsSync(path.join(ctx.config.metaRoot, 'trash', id))).toBe(false);
    expect((await req('DELETE', `/api/trash/${id}`)).statusCode).toBe(404);
    expect((await req('DELETE', '/api/trash')).json()).toEqual({ removed: 2 });
    expect((await req('GET', '/api/trash')).json()).toEqual([]);
    expect(await readdir(path.join(ctx.config.metaRoot, 'trash'))).toEqual([]);
  });

  it('works with a device token', async () => {
    const dev = (await sync('POST', '/devices', { payload: { name: 'Mac', platform: 'macos', appVersion: '1.0' } })).json().token;
    expect((await req('GET', '/api/trash', { auth: dev })).statusCode).toBe(200);
  });
});
