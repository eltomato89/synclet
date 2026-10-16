import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import type { IndexSpace, IndexUser } from '../common/types';
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

describe('Trash API in team spaces', () => {
  let ctx: TestContext; let alice: IndexUser; let bob: IndexUser; let carol: IndexUser; let team: IndexSpace;
  const tokens = new Map<string, string>();
  const req = (as: IndexUser, method: string, url: string, opts: { payload?: unknown; body?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url,
      headers: { authorization: `Bearer ${tokens.get(as.id)}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const sync = (as: IndexUser, method: string, url: string, opts: { payload?: unknown; body?: string } = {}) => req(as, method, `/api/sync/v1${url}`, opts);
  const settle = () => ctx.app.get(FilesService).pendingTrash();

  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await createTestUser(ctx, 'alice');
    bob = await createTestUser(ctx, 'bob');
    carol = await createTestUser(ctx, 'carol');
    for (const u of [alice, bob, carol]) tokens.set(u.id, await ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })));
    team = await createTestSpace(ctx, 'Team');
    await ctx.prisma.spaceMember.createMany({ data: [
      { spaceId: team.id, userId: alice.id, role: 'write' },
      { spaceId: team.id, userId: bob.id, role: 'write' },
      { spaceId: team.id, userId: carol.id, role: 'read' },
    ] });
  });
  afterEach(async () => { await ctx.close(); });

  it('delete in a team space: visible to write members (spaceId, deletedBy), not to read members; another member restores it into the space', async () => {
    const folder = (await sync(alice, 'POST', '/items', { payload: { parentId: `r_${team.id}`, type: 'folder', name: 'Docs' } })).json();
    const f = (await sync(alice, 'POST', `/items/upload?parentId=${folder.id}&name=a.txt`, { body: 'AAA' })).json();
    const mine = (await sync(alice, 'POST', '/items/upload?parentId=root&name=mine.txt', { body: 'm' })).json();
    expect((await sync(alice, 'DELETE', `/items/${f.id}`)).statusCode).toBe(204);
    expect((await sync(alice, 'DELETE', `/items/${mine.id}`)).statusCode).toBe(204);
    await settle();

    const aliceList = (await req(alice, 'GET', '/api/trash')).json();
    expect(aliceList).toHaveLength(2);
    expect(aliceList.find((e: { name: string }) => e.name === 'mine.txt')).toMatchObject({ spaceId: 'personal', deletedBy: alice.id });
    const entry = aliceList.find((e: { name: string }) => e.name === 'a.txt');
    expect(entry).toMatchObject({ itemId: f.id, spaceId: team.id, deletedBy: alice.id, originalPath: 'Docs/a.txt' });
    const bobList = (await req(bob, 'GET', '/api/trash')).json();
    expect(bobList).toEqual([expect.objectContaining({ id: entry.id, spaceId: team.id, deletedBy: alice.id })]);
    expect((await req(carol, 'GET', '/api/trash')).json()).toEqual([]);
    // read members cannot restore or delete (403), non-members do not see it (404)
    expect((await req(carol, 'POST', `/api/trash/${entry.id}/restore`)).statusCode).toBe(403);
    expect((await req(carol, 'DELETE', `/api/trash/${entry.id}`)).statusCode).toBe(403);
    const eve = await createTestUser(ctx, 'eve');
    tokens.set(eve.id, await ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: eve.id } })));
    expect((await req(eve, 'POST', `/api/trash/${entry.id}/restore`)).statusCode).toBe(404);

    const res = await req(bob, 'POST', `/api/trash/${entry.id}/restore`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restoredTo: 'Docs/a.txt', item: { id: f.id, parentId: folder.id, spaceId: team.id } });
    expect((await sync(carol, 'GET', `/items/${f.id}/content`)).body).toBe('AAA');
    expect(existsSync(path.join(team.rootPath, 'Docs', 'a.txt'))).toBe(true);
    expect((await req(bob, 'GET', '/api/trash')).json()).toEqual([]);
  });

  it('emptying the trash empties only the personal space unless ?space= is given', async () => {
    const t = (await sync(alice, 'POST', `/items/upload?parentId=r_${team.id}&name=t.txt`, { body: 't' })).json();
    const p = (await sync(alice, 'POST', '/items/upload?parentId=root&name=p.txt', { body: 'p' })).json();
    await sync(alice, 'DELETE', `/items/${t.id}`);
    await sync(alice, 'DELETE', `/items/${p.id}`);
    await settle();
    expect((await req(alice, 'DELETE', '/api/trash')).json()).toEqual({ removed: 1 });
    expect((await req(alice, 'GET', '/api/trash')).json()).toEqual([expect.objectContaining({ name: 't.txt', spaceId: team.id })]);
    expect((await req(carol, 'DELETE', `/api/trash?space=${team.id}`)).statusCode).toBe(403);
    expect((await req(alice, 'DELETE', '/api/trash?space=00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await req(bob, 'DELETE', `/api/trash?space=${team.id}`)).json()).toEqual({ removed: 1 });
    expect((await req(alice, 'GET', '/api/trash')).json()).toEqual([]);
  });
});
