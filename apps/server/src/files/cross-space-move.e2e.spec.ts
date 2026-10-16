import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import type { IndexSpace, IndexUser } from '../common/types';
import { AuthService } from '../auth/auth.service';
import { FilesService } from './files.service';

const exists = (p: string) => stat(p).then(() => true, () => false);

describe('moving items between spaces (PATCH parentId in another space)', () => {
  let ctx: TestContext; let alice: IndexUser; let token: string; let team: IndexSpace;
  const api = (method: string, url: string, opts: { payload?: unknown; body?: string; as?: string; headers?: Record<string, string> } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const tokenOf = async (u: IndexUser) => ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
  const home = () => path.join(ctx.config.dataRoot, 'alice');

  beforeEach(async () => {
    ctx = await createTestApp({ versions: true });
    alice = await createTestUser(ctx, 'alice');
    token = await tokenOf(alice);
    team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: alice.id, role: 'write' } });
  });
  afterEach(async () => { await ctx.close(); });

  it('personal → team and back keeps the id; disk, rows and both journals follow', async () => {
    const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Docs' } })).json();
    const child = (await api('POST', `/items/upload?parentId=${folder.id}&name=a.txt`, { body: 'aaa' })).json();
    const p0 = (await api('GET', '/cursor')).json().cursor;
    const t0 = (await api('GET', `/cursor?space=${team.id}`)).json().cursor;

    const moved = await api('PATCH', `/items/${folder.id}`, { payload: { parentId: `r_${team.id}` } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: folder.id, parentId: `r_${team.id}`, spaceId: team.id, name: 'Docs' });
    expect(await exists(path.join(home(), 'Docs'))).toBe(false);
    expect(await readFile(path.join(team.rootPath, 'Docs', 'a.txt'), 'utf8')).toBe('aaa');
    const rows = await ctx.prisma.item.findMany({ where: { id: { in: [folder.id.slice(2), child.id.slice(2)] } } });
    expect(rows.map((r) => [r.spaceId, r.path]).sort()).toEqual([[team.id, 'Docs'], [team.id, 'Docs/a.txt']]);
    expect((await api('GET', `/items/${child.id}`)).json()).toMatchObject({ id: child.id, parentId: folder.id, spaceId: team.id });
    expect((await api('GET', `/items/${child.id}/content`)).body).toBe('aaa');

    const p = (await api('GET', `/changes?cursor=${p0}`)).json();
    expect(p.changes).toEqual(expect.arrayContaining([{ op: 'delete', id: folder.id }, { op: 'delete', id: child.id }]));
    expect(p.changes).toHaveLength(2);
    const t = (await api('GET', `/changes?space=${team.id}&cursor=${t0}`)).json();
    expect(t.changes.map((c: { op: string; item: { id: string } }) => [c.op, c.item.id]).sort()).toEqual([['upsert', child.id], ['upsert', folder.id]].sort());

    // … and back to the personal root, with a new name.
    const back = await api('PATCH', `/items/${folder.id}`, { payload: { parentId: 'root', name: 'Docs2' } });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ id: folder.id, parentId: 'root', spaceId: 'personal', name: 'Docs2' });
    expect(await readFile(path.join(home(), 'Docs2', 'a.txt'), 'utf8')).toBe('aaa');
    expect(await exists(path.join(team.rootPath, 'Docs'))).toBe(false);
    expect((await api('GET', `/items/r_${team.id}/children`)).json().items).toEqual([]);
  });

  it('a file moved across spaces keeps its versions', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=v.txt', { body: 'one' })).json();
    expect((await api('PUT', `/items/${f.id}/content`, { body: 'two', headers: { 'if-match': '*' } })).statusCode).toBe(200);
    expect(await ctx.prisma.fileVersion.count({ where: { itemId: f.id.slice(2), spaceId: alice.id } })).toBe(1);
    expect((await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${team.id}` } })).statusCode).toBe(200);
    const versions = await ctx.prisma.fileVersion.findMany({ where: { itemId: f.id.slice(2) } });
    expect(versions).toHaveLength(1);
    expect(versions[0].spaceId).toBe(team.id);
    expect(versions[0].storePath).toBe(path.join(path.resolve(ctx.config.metaRoot, 'versions'), team.id, f.id.slice(2), path.basename(versions[0].storePath)));
    expect(await readFile(versions[0].storePath, 'utf8')).toBe('one');
  });

  it('falls back to copy + remove when the spaces are on different file systems (EXDEV)', async () => {
    const files = ctx.app.get(FilesService);
    const real = files.moveOps.moveNoReplace;
    const spy = jest.fn().mockRejectedValueOnce(Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })).mockImplementation(real);
    files.moveOps.moveNoReplace = spy;
    try {
      const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Big' } })).json();
      await api('POST', `/items/upload?parentId=${folder.id}&name=b.txt`, { body: 'bbb' });
      const res = await api('PATCH', `/items/${folder.id}`, { payload: { parentId: `r_${team.id}` } });
      expect(res.statusCode).toBe(200);
      expect(spy).toHaveBeenCalled();
      expect(await readFile(path.join(team.rootPath, 'Big', 'b.txt'), 'utf8')).toBe('bbb');
      expect(await exists(path.join(home(), 'Big'))).toBe(false);
      expect((await ctx.prisma.item.findFirstOrThrow({ where: { id: folder.id.slice(2) } })).spaceId).toBe(team.id);
    } finally {
      files.moveOps.moveNoReplace = real;
    }
  });

  it('a target space without write → 403 and nothing moves; without access → 404', async () => {
    const carol = await createTestUser(ctx, 'carol');
    const carolToken = await tokenOf(carol);
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: carol.id, role: 'read' } });
    const f = (await api('POST', '/items/upload?parentId=root&name=c.txt', { body: 'c', as: carolToken })).json();
    const res = await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${team.id}` }, as: carolToken });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
    expect(await exists(path.join(ctx.config.dataRoot, 'carol', 'c.txt'))).toBe(true);
    expect(await exists(path.join(team.rootPath, 'c.txt'))).toBe(false);
    expect((await ctx.prisma.item.findFirstOrThrow({ where: { id: f.id.slice(2) } })).spaceId).toBe(carol.id);
    const other = await createTestSpace(ctx, 'Other');
    expect((await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${other.id}` }, as: carolToken })).statusCode).toBe(404);
  });

  it('a name taken in the target → 409, nothing moves', async () => {
    await api('POST', `/items/upload?parentId=r_${team.id}&name=x.txt`, { body: 'team' });
    const f = (await api('POST', '/items/upload?parentId=root&name=x.txt', { body: 'mine' })).json();
    const res = await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${team.id}` } });
    expect(res.statusCode).toBe(409);
    expect(await readFile(path.join(home(), 'x.txt'), 'utf8')).toBe('mine');
    expect(await readFile(path.join(team.rootPath, 'x.txt'), 'utf8')).toBe('team');
  });
});
