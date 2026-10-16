import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import type { IndexSpace, IndexUser } from '../common/types';
import { AuthService } from '../auth/auth.service';

describe('Sync API spaces (account, roots, per-space changes)', () => {
  let ctx: TestContext; let alice: IndexUser; let token: string; let team: IndexSpace;
  const api = (method: string, url: string, opts: { payload?: unknown; body?: string; as?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const tokenOf = async (u: IndexUser) => ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }));

  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await createTestUser(ctx, 'alice');
    token = await tokenOf(alice);
    team = await createTestSpace(ctx, 'Zeta');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: alice.id, role: 'write' } });
  });
  afterEach(async () => { await ctx.close(); });

  it('GET /account lists personal, team folders and external storages, each by name', async () => {
    const alpha = await createTestSpace(ctx, 'Alpha');
    const group = await ctx.prisma.group.create({ data: { name: 'Fam', nameKey: 'fam' } });
    await ctx.prisma.groupMember.create({ data: { groupId: group.id, userId: alice.id } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: alpha.id, groupId: group.id, role: 'read' } });
    const nas = await createTestSpace(ctx, 'NAS', 'external');
    await ctx.prisma.spaceMember.create({ data: { spaceId: nas.id, userId: alice.id, role: 'write' } });
    const gone = await createTestSpace(ctx, 'Gone', 'external', { status: 'missing' });
    await ctx.prisma.spaceMember.create({ data: { spaceId: gone.id, userId: alice.id, role: 'write' } });
    const removed = await createTestSpace(ctx, 'Removed');
    await ctx.prisma.spaceMember.create({ data: { spaceId: removed.id, userId: alice.id, role: 'write' } });
    await ctx.prisma.space.update({ where: { id: removed.id }, data: { status: 'ignored' } });
    await createTestSpace(ctx, 'Hidden'); // no membership

    const account = (await api('GET', '/account')).json();
    expect(account.spaces).toEqual([
      { id: 'personal', kind: 'personal', name: 'Meine Dateien', rootId: 'root', canWrite: true, status: 'available' },
      { id: alpha.id, kind: 'shared', name: 'Alpha', rootId: `r_${alpha.id}`, canWrite: false, status: 'available' },
      { id: team.id, kind: 'shared', name: 'Zeta', rootId: `r_${team.id}`, canWrite: true, status: 'available' },
      { id: gone.id, kind: 'external', name: 'Gone', rootId: `r_${gone.id}`, canWrite: false, status: 'missing' },
      { id: nas.id, kind: 'external', name: 'NAS', rootId: `r_${nas.id}`, canWrite: true, status: 'available' },
    ]);
    // Unchanged for old clients: personal cursor and usage.
    expect(account.cursor).toBe((await api('GET', '/cursor')).json().cursor);
    expect(account.areas).toEqual({ personal: true, shared: false, customers: false, projects: false });
  });

  it('GET /items/r_<uuid> is the virtual space root', async () => {
    const root = (await api('GET', `/items/r_${team.id}`)).json();
    expect(root).toMatchObject({
      id: `r_${team.id}`, parentId: null, type: 'folder', kind: 'root', name: 'Zeta', spaceId: team.id,
      capabilities: { read: true, write: false, rename: false, move: false, delete: false, addChildren: true },
    });
    const bob = await createTestUser(ctx, 'bob');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: bob.id, role: 'read' } });
    expect((await api('GET', `/items/r_${team.id}`, { as: await tokenOf(bob) })).json().capabilities.addChildren).toBe(false);
    // The personal root keeps its shape, plus spaceId.
    expect((await api('GET', '/items/root')).json()).toMatchObject({ id: 'root', kind: 'root', parentId: null, spaceId: 'personal' });
    // Unknown space → 404, malformed root id → 400.
    expect((await api('GET', '/items/r_00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await api('GET', '/items/r_nope')).statusCode).toBe(400);
    // r_<root> cannot be renamed, moved or deleted.
    expect((await api('PATCH', `/items/r_${team.id}`, { payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await api('DELETE', `/items/r_${team.id}`)).statusCode).toBe(403);
  });

  it('children of a team root carry parentId r_<uuid>, spaceId and the space cursor', async () => {
    const before = (await api('GET', `/cursor?space=${team.id}`)).json().cursor;
    const folder = (await api('POST', '/items', { payload: { parentId: `r_${team.id}`, type: 'folder', name: 'Docs' } })).json();
    expect(folder).toMatchObject({ parentId: `r_${team.id}`, spaceId: team.id, name: 'Docs' });
    const file = (await api('POST', `/items/upload?parentId=${folder.id}&name=a.txt`, { body: 'a' })).json();
    expect(file).toMatchObject({ parentId: folder.id, spaceId: team.id });
    const page = (await api('GET', `/items/r_${team.id}/children`)).json();
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([folder.id]);
    expect(page.cursor).toBe((await api('GET', `/cursor?space=${team.id}`)).json().cursor);
    expect(page.cursor).not.toBe(before);
    const sub = (await api('GET', `/items/${folder.id}/children`)).json();
    expect(sub.items).toEqual([expect.objectContaining({ id: file.id, spaceId: team.id })]);
    expect(sub.cursor).toBe(page.cursor);
    // Personal root children do not include team items.
    expect((await api('GET', '/items/root/children')).json().items).toEqual([]);
  });

  it('/changes?space=<uuid> sees team edits, the personal feed does not', async () => {
    const personal0 = (await api('GET', '/cursor')).json().cursor;
    const team0 = (await api('GET', `/cursor?space=${team.id}`)).json().cursor;
    const folder = (await api('POST', '/items', { payload: { parentId: `r_${team.id}`, type: 'folder', name: 'T' } })).json();
    const t = (await api('GET', `/changes?space=${team.id}&cursor=${team0}`)).json();
    expect(t.changes).toEqual([{ op: 'upsert', item: expect.objectContaining({ id: folder.id, spaceId: team.id, parentId: `r_${team.id}` }) }]);
    const p = (await api('GET', `/changes?cursor=${personal0}`)).json();
    expect(p.changes).toEqual([]);
    expect(p.cursor).toBe(personal0);
    // ?space=personal is the same feed as no parameter.
    expect((await api('GET', `/changes?space=personal&cursor=${personal0}`)).json()).toEqual(p);
    // No access, unknown or malformed space → 404.
    const other = await createTestSpace(ctx, 'Other');
    for (const s of [other.id, '00000000-0000-4000-8000-000000000000', 'nope']) {
      expect((await api('GET', `/cursor?space=${s}`)).statusCode).toBe(404);
      expect((await api('GET', `/changes?space=${s}&cursor=0`)).statusCode).toBe(404);
    }
  });

  it('an old client without `space` gets the unchanged personal feed', async () => {
    const c0 = (await api('GET', '/cursor')).json().cursor;
    const f = (await api('POST', '/items/upload?parentId=root&name=p.txt', { body: 'p' })).json();
    await api('POST', '/items', { payload: { parentId: `r_${team.id}`, type: 'folder', name: 'T' } });
    const page = (await api('GET', `/changes?cursor=${c0}`)).json();
    expect(page.changes).toEqual([{ op: 'upsert', item: expect.objectContaining({ id: f.id, parentId: 'root', spaceId: 'personal' }) }]);
    expect(page.cursor).toBe((await api('GET', '/cursor')).json().cursor);
    expect((await api('GET', '/account')).json().cursor).toBe(page.cursor);
  });
});
