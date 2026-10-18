import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, personalSpace, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import { InsufficientStorageError } from '../common/storage-errors';
import type { IndexSpace, IndexUser } from '../common/types';
import { FilesService } from '../files/files.service';
import { IndexerService } from '../indexer/indexer.service';
import { SchedulerService } from '../indexer/scheduler.service';
import { OperationsRunner } from './operations.runner';

describe('OperationsRunner', () => {
  let ctx: TestContext; let alice: IndexUser; let token: string; let team: IndexSpace; let runner: OperationsRunner; let files: FilesService;
  const api = (method: string, url: string, opts: { payload?: unknown; body?: string; as?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const tokenOf = async (u: IndexUser) => ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
  const mkdir = async (parentId: string, name: string, as?: string) => (await api('POST', '/items', { payload: { parentId, type: 'folder', name }, as })).json();
  const upload = async (parentId: string, name: string, body: string, as?: string) =>
    (await api('POST', `/items/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, { body, as })).json();
  const start = async (payload: unknown, as?: string) => {
    const r = await api('POST', '/operations', { payload, as });
    expect(r.statusCode).toBe(201);
    return r.json() as { id: string };
  };
  const op = async (id: string, as?: string) => (await api('GET', `/operations/${id}`, { as })).json();
  const names = async (parentId: string) => ((await api('GET', `/items/${parentId}/children`)).json().items as { name: string }[]).map((i) => i.name).sort();
  const teamRoot = () => `r_${team.id}`;

  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await createTestUser(ctx, 'alice');
    token = await tokenOf(alice);
    team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: alice.id, role: 'write' } });
    runner = ctx.app.get(OperationsRunner);
    files = ctx.app.get(FilesService);
  });
  afterEach(async () => { await runner.idle(); await ctx.close(); });

  it('copies several items into another space and reports results and progress', async () => {
    const docs = await mkdir('root', 'Docs');
    await upload(docs.id, 'a.txt', 'aaa');
    const b = await upload('root', 'b.txt', 'bb');
    const { id } = await start({ kind: 'copy', itemIds: [docs.id, b.id], targetId: teamRoot() });
    await runner.idle();
    const done = await op(id);
    expect(done).toMatchObject({ status: 'done', totalItems: 3, doneItems: 3, totalBytes: 5, doneBytes: 5, error: null });
    expect(done.finishedAt).not.toBeNull();
    expect(done.results.map((r: { name: string; outcome: string }) => [r.name, r.outcome])).toEqual([['Docs', 'done'], ['b.txt', 'done']]);
    expect(done.results[0].resultId).toMatch(/^d_/);
    expect(await readFile(path.join(team.rootPath, 'Docs', 'a.txt'), 'utf8')).toBe('aaa');
    expect(await names('root')).toEqual(['Docs', 'b.txt']); // sources stay
  });

  it('copies out of a read-only space', async () => {
    const nas = await createTestSpace(ctx, 'NAS', 'external');
    await ctx.prisma.spaceMember.create({ data: { spaceId: nas.id, userId: alice.id, role: 'read' } });
    await writeFile(path.join(nas.rootPath, 'scan.pdf'), 'pdf');
    await ctx.app.get(IndexerService).fullScan(nas);
    const scan = ((await api('GET', `/items/r_${nas.id}/children`)).json().items as { id: string }[])[0];
    const { id } = await start({ kind: 'copy', itemIds: [scan.id], targetId: 'root' });
    await runner.idle();
    expect((await op(id)).status).toBe('done');
    expect(await readFile(path.join(ctx.config.dataRoot, 'alice', 'scan.pdf'), 'utf8')).toBe('pdf');
  });

  it('moves and deletes several items', async () => {
    const t = await mkdir('root', 'Target');
    const a = await upload('root', 'a.txt', 'a');
    const b = await upload('root', 'b.txt', 'b');
    await start({ kind: 'move', itemIds: [a.id, b.id], targetId: t.id });
    await runner.idle();
    expect(await names(t.id)).toEqual(['a.txt', 'b.txt']);
    const { id } = await start({ kind: 'delete', itemIds: [a.id, b.id] });
    await runner.idle();
    expect((await op(id)).status).toBe('done');
    expect(await names(t.id)).toEqual([]);
    await files.pendingTrash();
    expect(await ctx.prisma.trashEntry.count()).toBe(2);
  });

  it('copying into the source folder keeps both without asking; moving there is a no-op', async () => {
    const a = await upload('root', 'a.txt', 'a');
    const c = await start({ kind: 'copy', itemIds: [a.id], targetId: 'root' });
    await runner.idle();
    expect((await op(c.id)).status).toBe('done');
    expect(await names('root')).toEqual(['a (2).txt', 'a.txt']);
    const m = await start({ kind: 'move', itemIds: [a.id], targetId: 'root' });
    await runner.idle();
    expect((await op(m.id)).results[0]).toMatchObject({ outcome: 'done', resultId: a.id });
  });

  it('waits on a conflict; keepBoth once, then skip for all', async () => {
    const t = await mkdir('root', 'T');
    await upload(t.id, 'a.txt', 'old-a');
    await upload(t.id, 'b.txt', 'old-b');
    await upload(t.id, 'c.txt', 'old-c');
    const src = await mkdir('root', 'S');
    const ids = [await upload(src.id, 'a.txt', 'A'), await upload(src.id, 'b.txt', 'B'), await upload(src.id, 'c.txt', 'C')].map((x) => x.id);
    const { id } = await start({ kind: 'copy', itemIds: ids, targetId: t.id });
    await runner.idle();
    let cur = await op(id);
    expect(cur).toMatchObject({ status: 'waiting', doneItems: 0, conflict: { sourceId: ids[0], name: 'a.txt', canReplace: true, source: { type: 'file', size: 1 }, existing: { type: 'file', size: 5 } } });
    await api('POST', `/operations/${id}/resolve`, { payload: { action: 'keepBoth', applyToAll: false } });
    await runner.idle();
    cur = await op(id);
    expect(cur).toMatchObject({ status: 'waiting', conflict: { sourceId: ids[1], name: 'b.txt' } });
    await api('POST', `/operations/${id}/resolve`, { payload: { action: 'skip', applyToAll: true } });
    await runner.idle();
    cur = await op(id);
    expect(cur.status).toBe('done');
    expect(cur.results.map((r: { outcome: string }) => r.outcome)).toEqual(['done', 'skipped', 'skipped']);
    expect(await names(t.id)).toEqual(['a (2).txt', 'a.txt', 'b.txt', 'c.txt']);
  });

  it('replace moves the existing item (a whole folder) to the trash first', async () => {
    const t = await mkdir('root', 'T');
    const old = await mkdir(t.id, 'Docs');
    await upload(old.id, 'old.txt', 'old');
    const src = await mkdir('root', 'S');
    const docs = await mkdir(src.id, 'Docs');
    await upload(docs.id, 'new.txt', 'new');
    const { id } = await start({ kind: 'move', itemIds: [docs.id], targetId: t.id });
    await runner.idle();
    expect((await op(id)).status).toBe('waiting');
    await api('POST', `/operations/${id}/resolve`, { payload: { action: 'replace', applyToAll: false } });
    await runner.idle();
    expect((await op(id)).status).toBe('done');
    expect(await readdir(path.join(ctx.config.dataRoot, 'alice', 'T', 'Docs'))).toEqual(['new.txt']);
    await files.pendingTrash();
    expect(await ctx.prisma.trashEntry.findMany({ select: { name: true, originalPath: true } })).toEqual([{ name: 'Docs', originalPath: 'T/Docs' }]);
  });

  it('never replaces an item that is itself a source; replace-for-all falls back to asking', async () => {
    const t = await mkdir('root', 'T');
    const inT = await upload(t.id, 'x.txt', 'in-t');
    const a = await mkdir('root', 'A');
    const fromA = await upload(a.id, 'x.txt', 'from-a');
    const { id } = await start({ kind: 'move', itemIds: [fromA.id, inT.id], targetId: t.id });
    await runner.idle();
    expect((await op(id)).conflict).toMatchObject({ sourceId: fromA.id, canReplace: false });
    expect((await api('POST', `/operations/${id}/resolve`, { payload: { action: 'replace', applyToAll: true } })).statusCode).toBe(400);
    await ctx.prisma.operation.update({ where: { id }, data: { status: 'queued', policy: 'replace', conflict: undefined } });
    runner.kick();
    await runner.idle();
    expect(await op(id)).toMatchObject({ status: 'waiting', conflict: { canReplace: false } });
  });

  it('never replaces a folder that contains one of the sources', async () => {
    const t = await mkdir('root', 'T');
    const docs = await mkdir(t.id, 'Docs');
    const inner = await mkdir(docs.id, 'Docs');
    const { id } = await start({ kind: 'move', itemIds: [inner.id], targetId: t.id });
    await runner.idle();
    expect(await op(id)).toMatchObject({ status: 'waiting', conflict: { sourceId: inner.id, canReplace: false } });
    expect((await api('POST', `/operations/${id}/resolve`, { payload: { action: 'replace', applyToAll: false } })).statusCode).toBe(400);
  });

  it('copy+replace trashes the old item only after the copy: a cancelled copy leaves it in place', async () => {
    const t = await mkdir('root', 'T');
    await upload(t.id, 'a.txt', 'old');
    const a = await upload('root', 'a.txt', 'new-content');
    const { id } = await start({ kind: 'copy', itemIds: [a.id], targetId: t.id });
    await runner.idle();
    expect((await op(id)).status).toBe('waiting');
    const real = files.copy.bind(files);
    jest.spyOn(files, 'copy').mockImplementation((s, d, i, p, o) => real(s, d, i, p, { ...o, onProgress: (n) => { o.onProgress?.(n); runner.cancelRunning(id); } }));
    await api('POST', `/operations/${id}/resolve`, { payload: { action: 'replace', applyToAll: false } });
    await runner.idle();
    expect(await readFile(path.join(ctx.config.dataRoot, 'alice', 'T', 'a.txt'), 'utf8')).toBe('old');
    await files.pendingTrash();
    expect(await ctx.prisma.trashEntry.count()).toBe(0);
  });

  it('copy+replace success: old item in the trash, new content at the target', async () => {
    const t = await mkdir('root', 'T');
    await upload(t.id, 'a.txt', 'old');
    const a = await upload('root', 'a.txt', 'new-content');
    const { id } = await start({ kind: 'copy', itemIds: [a.id], targetId: t.id });
    await runner.idle();
    await api('POST', `/operations/${id}/resolve`, { payload: { action: 'replace', applyToAll: false } });
    await runner.idle();
    expect((await op(id)).status).toBe('done');
    expect(await readFile(path.join(ctx.config.dataRoot, 'alice', 'T', 'a.txt'), 'utf8')).toBe('new-content');
    await files.pendingTrash();
    expect(await ctx.prisma.trashEntry.findMany({ select: { name: true, originalPath: true } })).toEqual([{ name: 'a.txt', originalPath: 'T/a.txt' }]);
  });

  it('copy+replace does not trash an existing item that was renamed during the copy', async () => {
    const t = await mkdir('root', 'T');
    const old = await upload(t.id, 'a.txt', 'old');
    const a = await upload('root', 'a.txt', 'new-content');
    const { id } = await start({ kind: 'copy', itemIds: [a.id], targetId: t.id });
    await runner.idle();
    expect((await op(id)).status).toBe('waiting');
    const real = files.copy.bind(files);
    let renamed: Promise<unknown> | null = null;
    jest.spyOn(files, 'copy').mockImplementation(async (s, d, i, p, o) => real(s, d, i, p, {
      ...o,
      onProgress: (n) => { o.onProgress?.(n); renamed ??= api('PATCH', `/items/${old.id}`, { payload: { name: 'kept.txt' } }); },
      beforePublish: async () => { await renamed; await o.beforePublish?.(); },
    }));
    await api('POST', `/operations/${id}/resolve`, { payload: { action: 'replace', applyToAll: false } });
    await runner.idle();
    expect((await op(id)).status).toBe('done');
    expect(await names(t.id)).toEqual(['a.txt', 'kept.txt']);
    expect(await readFile(path.join(ctx.config.dataRoot, 'alice', 'T', 'kept.txt'), 'utf8')).toBe('old');
    expect(await readFile(path.join(ctx.config.dataRoot, 'alice', 'T', 'a.txt'), 'utf8')).toBe('new-content');
    await files.pendingTrash();
    expect(await ctx.prisma.trashEntry.count()).toBe(0);
  });

  it('a vanished source fails only that item', async () => {
    const t = await mkdir('root', 'T');
    const a = await upload('root', 'a.txt', 'a');
    const b = await upload('root', 'b.txt', 'b');
    jest.spyOn(runner, 'kick').mockImplementationOnce(() => {}); // keep it queued while deleting a
    const { id } = await start({ kind: 'copy', itemIds: [a.id, b.id], targetId: t.id });
    await api('DELETE', `/items/${a.id}`);
    runner.kick();
    await runner.idle();
    const cur = await op(id);
    expect(cur.status).toBe('done');
    expect(cur.results.map((r: { outcome: string; error?: string }) => [r.outcome, r.error ?? null])).toEqual([['failed', 'not_found'], ['done', null]]);
  });

  it('aborts when the target folder is gone or the disk is full', async () => {
    const t = await mkdir('root', 'T');
    const a = await upload('root', 'a.txt', 'a');
    jest.spyOn(runner, 'kick').mockImplementationOnce(() => {});
    const gone = await start({ kind: 'copy', itemIds: [a.id], targetId: t.id });
    await api('DELETE', `/items/${t.id}`);
    runner.kick();
    await runner.idle();
    expect(await op(gone.id)).toMatchObject({ status: 'failed', error: 'target_missing', doneItems: 0 });

    jest.spyOn(files, 'copy').mockRejectedValueOnce(new InsufficientStorageError());
    const full = await start({ kind: 'copy', itemIds: [a.id], targetId: teamRoot() });
    await runner.idle();
    expect(await op(full.id)).toMatchObject({ status: 'failed', error: 'storage_full' });
  });

  it('cancel stops between items and keeps what is done', async () => {
    const items = [await upload('root', '1.txt', '1'), await upload('root', '2.txt', '2'), await upload('root', '3.txt', '3')];
    const real = files.remove.bind(files);
    let calls = 0;
    let opId = '';
    jest.spyOn(files, 'remove').mockImplementation(async (...args: Parameters<FilesService['remove']>) => {
      await real(...args);
      if (++calls === 1) await api('POST', `/operations/${opId}/cancel`);
    });
    jest.spyOn(runner, 'kick').mockImplementationOnce(() => {});
    opId = (await start({ kind: 'delete', itemIds: items.map((i) => i.id) })).id;
    runner.kick();
    await runner.idle();
    const cur = await op(opId);
    expect(cur.status).toBe('cancelled');
    expect(cur.results).toHaveLength(1);
    expect(await names('root')).toEqual(['2.txt', '3.txt']);
  });

  it('resumes at nextIndex after a restart without duplicating finished items', async () => {
    const a = await upload('root', 'a.txt', 'a');
    const b = await upload('root', 'b.txt', 'b');
    jest.spyOn(runner, 'kick').mockImplementation(() => {});
    const { id } = await start({ kind: 'copy', itemIds: [a.id, b.id], targetId: teamRoot() });
    // As if the server died after the first item: a is copied, status still running.
    await files.copy(personalSpace(ctx, alice), team, a.id.slice(2), null, { onConflict: 'fail' });
    await ctx.prisma.operation.update({ where: { id }, data: { status: 'running', nextIndex: 1, doneItems: 1, results: [{ sourceId: a.id, name: 'a.txt', outcome: 'done' }] } });
    jest.restoreAllMocks();
    expect(await runner.recover()).toBe(1);
    runner.kick();
    await runner.idle();
    expect(await op(id)).toMatchObject({ status: 'done', doneItems: 2 });
    expect(await names(teamRoot())).toEqual(['a.txt', 'b.txt']);
  });

  it('runs one operation per user and at most two at a time', async () => {
    const bob = await createTestUser(ctx, 'bob');
    const bobToken = await tokenOf(bob);
    const a1 = await upload('root', 'a1.txt', '1');
    const a2 = await upload('root', 'a2.txt', '2');
    const b1 = await upload('root', 'b1.txt', '1', bobToken);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = files.remove.bind(files);
    jest.spyOn(files, 'remove').mockImplementation(async (...args: Parameters<FilesService['remove']>) => { await gate; await real(...args); });
    const o1 = await start({ kind: 'delete', itemIds: [a1.id] });
    const o2 = await start({ kind: 'delete', itemIds: [a2.id] });
    const o3 = await start({ kind: 'delete', itemIds: [b1.id] }, bobToken);
    const statuses = async () => Object.fromEntries((await ctx.prisma.operation.findMany()).map((o) => [o.id, o.status]));
    for (let i = 0; i < 100 && Object.values(await statuses()).filter((s) => s === 'running').length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await statuses()).toEqual({ [o1.id]: 'running', [o2.id]: 'queued', [o3.id]: 'running' });
    release();
    await runner.idle();
    expect(Object.values(await statuses())).toEqual(['done', 'done', 'done']);
  });

  it('maintenance removes operations finished more than 7 days ago', async () => {
    const day = 24 * 3600 * 1000;
    const mk = (finishedAt: Date | null, status: string) => ctx.prisma.operation.create({ data: { userId: alice.id, kind: 'delete', status, sourceIds: [], finishedAt } });
    await mk(new Date(Date.now() - 8 * day), 'done');
    const recent = await mk(new Date(Date.now() - 6 * day), 'failed');
    const waiting = await mk(null, 'waiting');
    await ctx.app.get(SchedulerService).maintenance();
    expect((await ctx.prisma.operation.findMany({ select: { id: true } })).map((o) => o.id).sort()).toEqual([recent.id, waiting.id].sort());
  });
});
