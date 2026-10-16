import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

  describe('across file systems (EXDEV)', () => {
    let files: FilesService; let real: FilesService['moveOps']['moveNoReplace'];
    const exdev = () => Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
    beforeEach(() => {
      files = ctx.app.get(FilesService);
      real = files.moveOps.moveNoReplace;
      files.moveOps.moveNoReplace = jest.fn().mockRejectedValueOnce(exdev()).mockImplementation(real);
    });
    afterEach(() => {
      files.moveOps.moveNoReplace = real;
      files.moveOps.afterCopy = undefined;
    });
    const temps = async () => [...(await readdir(team.rootPath)), ...(await readdir(home()))].filter((n) => n.startsWith('.synclet-'));

    it('the copied rows get the new inodes: the next PUT with If-Match v1 succeeds', async () => {
      const f = (await api('POST', '/items/upload?parentId=root&name=i.txt', { body: 'one' })).json();
      expect((await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${team.id}` } })).statusCode).toBe(200);
      const row = await ctx.prisma.item.findFirstOrThrow({ where: { id: f.id.slice(2) } });
      const st = await stat(path.join(team.rootPath, 'i.txt'), { bigint: true });
      expect([row.ino, row.dev]).toEqual([st.ino, st.dev]);
      const put = await api('PUT', `/items/${f.id}/content`, { body: 'two', headers: { 'if-match': '"v1"' } });
      expect(put.statusCode).toBe(200);
      expect(put.json().version).toBe(2);
      expect(await temps()).toEqual([]);
    });

    it('a write to the source during the copy → 409 conflict, nothing moved or lost, temp copy removed', async () => {
      const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'W' } })).json();
      const f = (await api('POST', `/items/upload?parentId=${folder.id}&name=w.txt`, { body: 'old' })).json();
      files.moveOps.afterCopy = async () => {
        expect((await api('PUT', `/items/${f.id}/content`, { body: 'newer', headers: { 'if-match': '*' } })).statusCode).toBe(200);
      };
      const res = await api('PATCH', `/items/${folder.id}`, { payload: { parentId: `r_${team.id}` } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('conflict');
      expect(await readFile(path.join(home(), 'W', 'w.txt'), 'utf8')).toBe('newer');
      expect(await exists(path.join(team.rootPath, 'W'))).toBe(false);
      expect((await ctx.prisma.item.findFirstOrThrow({ where: { id: folder.id.slice(2) } })).spaceId).toBe(alice.id);
      expect(await temps()).toEqual([]);
      // The client retries: now it goes through.
      files.moveOps.afterCopy = undefined;
      files.moveOps.moveNoReplace = jest.fn().mockRejectedValueOnce(exdev()).mockImplementation(real);
      expect((await api('PATCH', `/items/${folder.id}`, { payload: { parentId: `r_${team.id}` } })).statusCode).toBe(200);
      expect(await readFile(path.join(team.rootPath, 'W', 'w.txt'), 'utf8')).toBe('newer');
    });

    it('a failure at publish (name taken meanwhile) → 409, source intact, temp copy removed', async () => {
      const f = (await api('POST', '/items/upload?parentId=root&name=n.txt', { body: 'mine' })).json();
      files.moveOps.afterCopy = async () => {
        expect((await api('POST', `/items/upload?parentId=r_${team.id}&name=n.txt`, { body: 'theirs' })).statusCode).toBe(201);
      };
      const res = await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${team.id}` } });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('name_conflict');
      expect(await readFile(path.join(home(), 'n.txt'), 'utf8')).toBe('mine');
      expect(await readFile(path.join(team.rootPath, 'n.txt'), 'utf8')).toBe('theirs');
      expect(await temps()).toEqual([]);
    });
  });

  it('an existing version folder at the target is merged, nothing overwritten', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=m.txt', { body: 'one' })).json();
    expect((await api('PUT', `/items/${f.id}/content`, { body: 'two', headers: { 'if-match': '*' } })).statusCode).toBe(200);
    const [v] = await ctx.prisma.fileVersion.findMany({ where: { itemId: f.id.slice(2) } });
    const strayDir = path.join(path.resolve(ctx.config.metaRoot, 'versions'), team.id, f.id.slice(2));
    await mkdir(strayDir, { recursive: true });
    await writeFile(path.join(strayDir, path.basename(v.storePath)), 'stray');
    expect((await api('PATCH', `/items/${f.id}`, { payload: { parentId: `r_${team.id}` } })).statusCode).toBe(200);
    const moved = await ctx.prisma.fileVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(moved.spaceId).toBe(team.id);
    expect(path.dirname(moved.storePath)).toBe(strayDir);
    expect(await readFile(moved.storePath, 'utf8')).toBe('one');
    expect(await readFile(path.join(strayDir, path.basename(v.storePath)), 'utf8')).toBe('stray');
  });
});
