import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import type { IndexSpace, IndexUser } from '../common/types';
import { OperationsRunner } from './operations.runner';
import { OperationsService } from './operations.service';

describe('operations API', () => {
  let ctx: TestContext; let alice: IndexUser; let token: string; let team: IndexSpace; let nas: IndexSpace;
  const api = (method: string, url: string, opts: { payload?: unknown; body?: string; as?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const tokenOf = async (u: IndexUser) => ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
  const mkdir = async (parentId: string, name: string) => (await api('POST', '/items', { payload: { parentId, type: 'folder', name } })).json();
  const upload = async (parentId: string, name: string, body: string) => (await api('POST', `/items/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, { body })).json();

  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await createTestUser(ctx, 'alice');
    token = await tokenOf(alice);
    team = await createTestSpace(ctx, 'Familie');
    nas = await createTestSpace(ctx, 'NAS', 'external');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: alice.id, role: 'write' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: nas.id, userId: alice.id, role: 'read' } });
    // Nothing runs in these tests: the runner's execution is covered in operations-runner.e2e.spec.ts.
    jest.spyOn(ctx.app.get(OperationsRunner), 'kick').mockImplementation(() => {});
  });
  afterEach(async () => { await ctx.close(); });

  it('creates a copy operation with totals and canonical ids', async () => {
    const docs = await mkdir('root', 'Docs');
    await upload(docs.id, 'a.txt', 'aaa');
    const f = await upload('root', 'b.txt', 'bb');
    const res = await api('POST', '/operations', { payload: { kind: 'copy', itemIds: [docs.id, f.id], targetId: `r_${team.id}` } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: 'copy', status: 'queued', targetId: `r_${team.id}`, targetName: 'Familie', itemCount: 2,
      totalItems: 3, doneItems: 0, totalBytes: 5, doneBytes: 0, conflict: null, results: [], error: null, finishedAt: null,
    });
    const row = await ctx.prisma.operation.findFirstOrThrow();
    expect(row.sourceIds).toEqual([docs.id, f.id]);
    expect((await api('GET', `/operations/${row.id}`)).json()).toMatchObject({ id: row.id });
    expect((await api('GET', '/operations?active=1')).json()).toHaveLength(1);
  });

  it('validates the request', async () => {
    const docs = await mkdir('root', 'Docs');
    const sub = await mkdir(docs.id, 'Sub');
    const f = await upload('root', 'b.txt', 'bb');
    const post = (payload: unknown) => api('POST', '/operations', { payload });
    expect((await post({ kind: 'copy', itemIds: [], targetId: 'root' })).statusCode).toBe(400);
    expect((await post({ kind: 'copy', itemIds: [f.id, f.id], targetId: docs.id })).statusCode).toBe(400);
    expect((await post({ kind: 'copy', itemIds: [f.id] })).statusCode).toBe(400); // target missing
    expect((await post({ kind: 'delete', itemIds: [f.id], targetId: 'root' })).statusCode).toBe(400);
    expect((await post({ kind: 'delete', itemIds: ['root'] })).statusCode).toBe(400); // a root
    expect((await post({ kind: 'copy', itemIds: [f.id], targetId: f.id })).statusCode).toBe(400); // not a folder
    expect((await post({ kind: 'copy', itemIds: Array.from({ length: 10_001 }, (_, i) => `f_${i}`), targetId: 'root' })).statusCode).toBe(400);
    // Into itself or its own subfolder.
    for (const targetId of [docs.id, sub.id]) {
      const r = await post({ kind: 'move', itemIds: [docs.id], targetId });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('invalid_target');
    }
    expect((await post({ kind: 'copy', itemIds: [docs.id], targetId: sub.id })).json().code).toBe('invalid_target');
    // A source inside another selected folder (any order, any depth).
    const deep = await upload(sub.id, 'c.txt', 'c');
    for (const itemIds of [[docs.id, sub.id], [deep.id, docs.id], [f.id, sub.id, deep.id]]) {
      const r = await post({ kind: 'delete', itemIds });
      expect([r.statusCode, r.json().code]).toEqual([400, 'invalid_request']);
    }
    expect(await ctx.prisma.operation.count()).toBe(0);
    // Siblings with a common prefix are not nested.
    const docs2 = await mkdir('root', 'Docs2');
    expect((await post({ kind: 'delete', itemIds: [docs.id, docs2.id] })).statusCode).toBe(201);
  });

  it('checks roles: copy needs read on sources, move/delete write; the target needs write', async () => {
    const onNas = await ctx.prisma.item.create({
      data: { spaceId: nas.id, parentId: null, type: 'file', name: 'n.txt', nameKey: 'n.txt', path: 'n.txt', size: 1n, mtime: new Date() },
    });
    const nasId = `f_${onNas.id}`;
    const r1 = await api('POST', '/operations', { payload: { kind: 'copy', itemIds: [nasId], targetId: 'root' } });
    expect(r1.statusCode).toBe(201);
    expect((await api('POST', '/operations', { payload: { kind: 'move', itemIds: [nasId], targetId: 'root' } })).statusCode).toBe(403);
    expect((await api('POST', '/operations', { payload: { kind: 'delete', itemIds: [nasId] } })).statusCode).toBe(403);
    const f = await upload('root', 'b.txt', 'bb');
    expect((await api('POST', '/operations', { payload: { kind: 'copy', itemIds: [f.id], targetId: `r_${nas.id}` } })).statusCode).toBe(403);
    expect((await api('POST', '/operations', { payload: { kind: 'copy', itemIds: ['f_00000000-0000-4000-8000-000000000000'], targetId: 'root' } })).statusCode).toBe(404);
  });

  it('refuses a copy larger than the free space at the target (507)', async () => {
    const f = await upload('root', 'b.txt', 'bbbb');
    ctx.app.get(OperationsService).freeBytes = async () => 3n;
    const r = await api('POST', '/operations', { payload: { kind: 'copy', itemIds: [f.id], targetId: `r_${team.id}` } });
    expect(r.statusCode).toBe(507);
    expect(r.json().code).toBe('insufficient_storage');
  });

  it('other users never see an operation (404)', async () => {
    const f = await upload('root', 'b.txt', 'bb');
    const op = (await api('POST', '/operations', { payload: { kind: 'delete', itemIds: [f.id] } })).json();
    const bob = await createTestUser(ctx, 'bob');
    const bobToken = await tokenOf(bob);
    expect((await api('GET', `/operations/${op.id}`, { as: bobToken })).statusCode).toBe(404);
    expect((await api('POST', `/operations/${op.id}/cancel`, { as: bobToken })).statusCode).toBe(404);
    expect((await api('GET', '/operations', { as: bobToken })).json()).toEqual([]);
    expect((await api('GET', '/operations/not-a-uuid')).statusCode).toBe(404);
  });

  it('resolve only while waiting; stores a one-shot decision or the policy', async () => {
    const f = await upload('root', 'b.txt', 'bb');
    const op = (await api('POST', '/operations', { payload: { kind: 'copy', itemIds: [f.id], targetId: `r_${team.id}` } })).json();
    expect((await api('POST', `/operations/${op.id}/resolve`, { payload: { action: 'skip', applyToAll: false } })).statusCode).toBe(409);
    const conflict = { sourceId: f.id, name: 'b.txt', source: { type: 'file', size: 2, modifiedAt: new Date().toISOString() }, existing: { id: 'f_x', type: 'file', size: 1, modifiedAt: new Date().toISOString() }, canReplace: false };
    await ctx.prisma.operation.update({ where: { id: op.id }, data: { status: 'waiting', conflict } });
    expect((await api('GET', `/operations/${op.id}`)).json().conflict).toMatchObject({ name: 'b.txt', canReplace: false });
    expect((await api('POST', `/operations/${op.id}/resolve`, { payload: { action: 'replace', applyToAll: false } })).statusCode).toBe(400);
    expect((await api('POST', `/operations/${op.id}/resolve`, { payload: { action: 'nope', applyToAll: false } })).statusCode).toBe(400);
    const r = await api('POST', `/operations/${op.id}/resolve`, { payload: { action: 'keepBoth', applyToAll: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'queued', conflict: null });
    let row = await ctx.prisma.operation.findUniqueOrThrow({ where: { id: op.id } });
    expect(row.conflict).toMatchObject({ sourceId: f.id, decision: 'keepBoth' });
    expect(row.policy).toBeNull();
    await ctx.prisma.operation.update({ where: { id: op.id }, data: { status: 'waiting', conflict } });
    await api('POST', `/operations/${op.id}/resolve`, { payload: { action: 'skip', applyToAll: true } });
    row = await ctx.prisma.operation.findUniqueOrThrow({ where: { id: op.id } });
    expect([row.status, row.policy, row.conflict]).toEqual(['queued', 'skip', null]);
  });

  it('cancel is idempotent and leaves finished operations unchanged', async () => {
    const f = await upload('root', 'b.txt', 'bb');
    const op = (await api('POST', '/operations', { payload: { kind: 'delete', itemIds: [f.id] } })).json();
    const c1 = await api('POST', `/operations/${op.id}/cancel`);
    expect(c1.statusCode).toBe(200);
    expect(c1.json()).toMatchObject({ status: 'cancelled' });
    expect(c1.json().finishedAt).not.toBeNull();
    expect((await api('POST', `/operations/${op.id}/cancel`)).json()).toMatchObject({ status: 'cancelled' });
    await ctx.prisma.operation.update({ where: { id: op.id }, data: { status: 'done' } });
    expect((await api('POST', `/operations/${op.id}/cancel`)).json()).toMatchObject({ status: 'done' });
    expect((await api('GET', '/operations?active=1')).json()).toEqual([]);
    expect((await api('GET', '/operations')).json()).toHaveLength(1);
  });

  it('is not reachable without a token', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/sync/v1/operations' });
    expect(r.statusCode).toBe(401);
  });
});
