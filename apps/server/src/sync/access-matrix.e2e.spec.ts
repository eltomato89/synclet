import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import type { IndexSpace } from '../common/types';
import { AuthService } from '../auth/auth.service';
import { DerivedStore } from '../derivatives/derived-store';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const metadata = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(',');

/**
 * Access matrix of the item routes in a team space: alice (write member), carol (read member),
 * bob (no access). No access → 404, read-only write attempt → 403, member → 2xx.
 */
describe('Sync API access per space', () => {
  let ctx: TestContext; let base: string; let team: IndexSpace;
  const tokens: Record<string, string> = {};
  let file: { id: string; sha256: string }; let folder: { id: string };

  const api = (who: string, method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string>; body?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${tokens[who]}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const tus = async (who: string, meta: Record<string, string>) => {
    const res = await fetch(`${base}/api/sync/v1/uploads`, {
      method: 'POST',
      headers: { 'tus-resumable': '1.0.0', authorization: `Bearer ${tokens[who]}`, 'upload-length': '3', 'upload-metadata': metadata(meta) },
    });
    const text = await res.text();
    return { statusCode: res.status, body: text };
  };

  beforeEach(async () => {
    ctx = await createTestApp();
    await ctx.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
    const auth = ctx.app.get(AuthService);
    for (const name of ['alice', 'bob', 'carol']) {
      const u = await createTestUser(ctx, name);
      tokens[name] = await auth.signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
      if (name === 'alice') tokens.aliceId = u.id;
      if (name === 'carol') tokens.carolId = u.id;
    }
    team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: tokens.aliceId, role: 'write' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: tokens.carolId, role: 'read' } });
    const up = await api('alice', 'POST', `/items/upload?parentId=r_${team.id}&name=f.txt`, { body: 'hello' });
    expect(up.statusCode).toBe(201);
    file = up.json();
    const mk = await api('alice', 'POST', '/items', { payload: { parentId: `r_${team.id}`, type: 'folder', name: 'd' } });
    expect(mk.statusCode).toBe(201);
    folder = mk.json();
    // A finished thumbnail, so the thumbnail route answers 200 for readers.
    await ctx.prisma.derivativeJob.create({ data: { sha: file.sha256, kind: 'thumb', status: 'done' } });
    const thumb = ctx.app.get(DerivedStore).pathFor(file.sha256, 'thumb', 256);
    await mkdir(path.dirname(thumb), { recursive: true });
    await writeFile(thumb, 'webp');
  });
  afterEach(async () => { await ctx.close(); });

  const reads: Array<[string, () => [string, string, Parameters<typeof api>[3]?]]> = [
    ['GET item', () => ['GET', `/items/${file.id}`]],
    ['GET children', () => ['GET', `/items/${folder.id}/children`]],
    ['GET root', () => ['GET', `/items/r_${team.id}`]],
    ['GET root children', () => ['GET', `/items/r_${team.id}/children`]],
    ['GET content', () => ['GET', `/items/${file.id}/content`]],
    ['GET thumbnail', () => ['GET', `/items/${file.id}/thumbnail`]],
    ['GET preview-text', () => ['GET', `/items/${file.id}/preview-text`]],
    ['POST download-token', () => ['POST', `/items/${file.id}/download-token`]],
    ['GET cursor', () => ['GET', `/cursor?space=${team.id}`]],
    ['GET changes', () => ['GET', `/changes?space=${team.id}&cursor=0`]],
  ];
  const writes: Array<[string, () => [string, string, Parameters<typeof api>[3]?]]> = [
    ['PUT content', () => ['PUT', `/items/${file.id}/content`, { body: 'new', headers: { 'if-match': '*' } }]],
    ['POST upload', () => ['POST', `/items/upload?parentId=${folder.id}&name=n.txt`, { body: 'x' }]],
    ['POST upload into root', () => ['POST', `/items/upload?parentId=r_${team.id}&name=n.txt`, { body: 'x' }]],
    ['POST items (folder)', () => ['POST', '/items', { payload: { parentId: folder.id, type: 'folder', name: 'sub' } }]],
    ['PATCH rename', () => ['PATCH', `/items/${file.id}`, { payload: { name: 'g.txt' } }]],
    ['PATCH move', () => ['PATCH', `/items/${file.id}`, { payload: { parentId: folder.id } }]],
    ['DELETE', () => ['DELETE', `/items/${file.id}`]],
  ];

  describe.each(reads)('%s', (_name, route) => {
    it('bob → 404, carol → 200, alice → 200', async () => {
      const [m, u, o] = route();
      const bob = await api('bob', m, u, o);
      expect(bob.statusCode).toBe(404);
      expect(bob.json()).toMatchObject({ statusCode: 404, code: 'not_found' });
      expect((await api('carol', m, u, o)).statusCode).toBeLessThan(300);
      expect((await api('alice', m, u, o)).statusCode).toBeLessThan(300);
    });
  });

  describe.each(writes)('%s', (_name, route) => {
    it('bob → 404, carol → 403, alice → 2xx', async () => {
      const [m, u, o] = route();
      expect((await api('bob', m, u, o)).statusCode).toBe(404);
      const carol = await api('carol', m, u, o);
      expect(carol.statusCode).toBe(403);
      expect(carol.json()).toMatchObject({ statusCode: 403, code: 'forbidden' });
      const alice = await api('alice', m, u, o);
      expect(alice.statusCode).toBeGreaterThanOrEqual(200);
      expect(alice.statusCode).toBeLessThan(300);
    });
  });

  it('tus create in a folder: bob → 404, carol → 403, alice → 201', async () => {
    const meta = { name: 't.txt', parentId: folder.id };
    expect((await tus('bob', meta)).statusCode).toBe(404);
    const carol = await tus('carol', meta);
    expect(carol.statusCode).toBe(403);
    expect(JSON.parse(carol.body).code).toBe('forbidden');
    expect((await tus('alice', meta)).statusCode).toBe(201);
    expect((await tus('alice', { name: 'u.txt', parentId: `r_${team.id}` })).statusCode).toBe(201);
  });

  it('tus replace: bob → 404, carol → 403, alice → 201', async () => {
    const meta = { itemId: file.id, ifMatch: 'v1' };
    expect((await tus('bob', meta)).statusCode).toBe(404);
    expect((await tus('carol', meta)).statusCode).toBe(403);
    expect((await tus('alice', meta)).statusCode).toBe(201);
  });

  it('a missing space → 503 space_unavailable for members, 404 for others', async () => {
    await ctx.prisma.space.update({ where: { id: team.id }, data: { status: 'missing' } });
    const res = await api('alice', 'GET', `/items/${file.id}/content`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ statusCode: 503, message: expect.any(String), code: 'space_unavailable' });
    expect((await api('bob', 'GET', `/items/${file.id}/content`)).statusCode).toBe(404);
  });

  it('an ignored (removed) space is gone for its former members', async () => {
    await ctx.prisma.space.update({ where: { id: team.id }, data: { status: 'ignored' } });
    expect((await api('alice', 'GET', `/items/${file.id}`)).statusCode).toBe(404);
    expect((await api('alice', 'GET', `/items/r_${team.id}`)).statusCode).toBe(404);
  });

  it('a download token carries the space and stops working once access is revoked', async () => {
    const minted = await api('carol', 'POST', `/items/${file.id}/download-token`);
    const { url, token } = minted.json();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.s).toBe(team.id);
    const ok = await ctx.app.inject({ method: 'GET', url });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('hello');
    await ctx.prisma.spaceMember.deleteMany({ where: { spaceId: team.id, userId: tokens.carolId } });
    expect((await ctx.app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('a read member sees read-only capabilities, a write member full ones', async () => {
    const caps = (await api('carol', 'GET', `/items/${file.id}`)).json().capabilities;
    expect(caps).toEqual({ read: true, write: false, rename: false, move: false, delete: false, addChildren: false });
    expect((await api('carol', 'GET', `/items/${folder.id}`)).json().capabilities.addChildren).toBe(false);
    expect((await api('alice', 'GET', `/items/${file.id}`)).json().capabilities).toEqual({ read: true, write: true, rename: true, move: true, delete: true, addChildren: false });
    expect((await api('alice', 'GET', `/items/${folder.id}`)).json().capabilities.addChildren).toBe(true);
  });
});
