import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, personalSpace, TestContext } from '../../test/context';
import { SyncError } from '../common/sync-error';
import type { IndexSpace, IndexUser } from '../common/types';
import { IndexerService } from '../indexer/indexer.service';
import { JournalService } from '../journal/journal.service';
import { FilesService } from './files.service';
import { Readable } from 'node:stream';

describe('FilesService.copy', () => {
  let ctx: TestContext; let files: FilesService; let alice: IndexUser; let home: IndexSpace; let team: IndexSpace;
  const body = (s: string) => Readable.from([Buffer.from(s)]);
  const live = (spaceId: string) => ctx.prisma.item.findMany({ where: { spaceId, deletedAt: null }, orderBy: { path: 'asc' } });

  beforeEach(async () => {
    ctx = await createTestApp();
    files = ctx.app.get(FilesService);
    alice = await createTestUser(ctx, 'alice');
    home = personalSpace(ctx, alice);
    team = await createTestSpace(ctx, 'Familie');
  });
  afterEach(async () => { await ctx.close(); });

  async function tree() {
    const docs = await files.createFolder(home, null, 'Docs');
    const sub = await files.createFolder(home, docs.id, 'Sub');
    const a = await files.upload(home, docs.id, 'a.txt', body('aaa'), {});
    await files.upload(home, sub.id, 'b.txt', body('bb'), {});
    return { docs, sub, a };
  }

  it('copies a folder tree within a space: new ids, same content, hashes and mtimes, journal upserts', async () => {
    const { docs, a } = await tree();
    const target = await files.createFolder(home, null, 'Target');
    const cursor = await ctx.app.get(JournalService).currentCursor(home.id);
    const copy = await files.copy(home, home, docs.id, target.id, { onConflict: 'fail' });
    expect(copy).toMatchObject({ name: 'Docs', path: 'Target/Docs', parentId: target.id, type: 'folder' });
    expect(copy.id).not.toBe(docs.id);
    const rows = (await live(home.id)).filter((r) => r.path.startsWith('Target/Docs'));
    expect(rows.map((r) => r.path)).toEqual(['Target/Docs', 'Target/Docs/Sub', 'Target/Docs/Sub/b.txt', 'Target/Docs/a.txt']);
    const copiedA = rows.find((r) => r.path === 'Target/Docs/a.txt')!;
    expect(copiedA.contentHash).toBe(a.contentHash);
    expect(copiedA.mtime.getTime()).toBe(a.mtime.getTime());
    expect(await readFile(path.join(home.rootPath, 'Target/Docs/Sub/b.txt'), 'utf8')).toBe('bb');
    // Source untouched.
    expect(await readFile(path.join(home.rootPath, 'Docs/a.txt'), 'utf8')).toBe('aaa');
    const page = await ctx.app.get(JournalService).changesSince(home.id, cursor, 100);
    expect(new Set(page.entries.map((e) => e.itemId))).toEqual(new Set(rows.map((r) => r.id)));
    // No temp leftovers; the indexer sees no difference.
    expect((await readdir(home.rootPath)).filter((n) => n.startsWith('.synclet'))).toEqual([]);
    const before = await live(home.id);
    await ctx.app.get(IndexerService).fullScan(home);
    expect((await live(home.id)).map((r) => [r.id, r.path])).toEqual(before.map((r) => [r.id, r.path]));
  });

  it('copies into another space (rows in the target space, stats refreshed)', async () => {
    const { docs } = await tree();
    const copy = await files.copy(home, team, docs.id, null, { onConflict: 'fail' });
    expect(copy).toMatchObject({ spaceId: team.id, path: 'Docs', parentId: null });
    const rows = await live(team.id);
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const st = await stat(path.join(team.rootPath, r.path), { bigint: true });
      expect([r.ino, r.dev]).toEqual([st.ino, st.dev]);
    }
    expect(await live(home.id)).toHaveLength(4);
  });

  it('name conflict: fail reports the existing item, rename picks "Name (2)"', async () => {
    const { a } = await tree();
    const docs2 = await files.createFolder(home, null, 'Other');
    const existing = await files.upload(home, docs2.id, 'a.txt', body('x'), {});
    await expect(files.copy(home, home, a.id, docs2.id, { onConflict: 'fail' }))
      .rejects.toMatchObject({ code: 'name_conflict', itemRow: expect.objectContaining({ id: existing.id }) });
    const copy = await files.copy(home, home, a.id, docs2.id, { onConflict: 'rename' });
    expect(copy.name).toBe('a (2).txt');
    // Copy into the same folder.
    const same = await files.copy(home, home, a.id, a.parentId, { onConflict: 'rename' });
    expect(same.name).toBe('a (2).txt');
    expect(same.parentId).toBe(a.parentId);
  });

  it('reports progress in bytes', async () => {
    const { docs } = await tree();
    let bytes = 0;
    await files.copy(home, team, docs.id, null, { onConflict: 'fail', onProgress: (n) => { bytes += n; } });
    expect(bytes).toBe(5);
  });

  it('a source changed during the copy fails with 409 and leaves nothing behind', async () => {
    const { docs } = await tree();
    const p = files.copy(home, team, docs.id, null, {
      onConflict: 'fail',
      onProgress: () => { writeFileSync(path.join(home.rootPath, 'Docs/new.txt'), 'n'); },
    });
    await expect(p).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(await live(team.id)).toEqual([]);
    expect(await readdir(team.rootPath)).toEqual([]);
  });

  it('an aborted copy throws AbortError and removes the temp tree', async () => {
    const { docs } = await tree();
    const ctl = new AbortController();
    await expect(files.copy(home, team, docs.id, null, { onConflict: 'fail', signal: ctl.signal, onProgress: () => ctl.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(team.rootPath)).toEqual([]);
  });

  it('the indexer never adopts a copy temp tree', async () => {
    await mkdir(path.join(team.rootPath, '.synclet-tmp-0123abcd', 'Docs'), { recursive: true });
    await writeFile(path.join(team.rootPath, '.synclet-tmp-0123abcd', 'Docs', 'x.txt'), 'x');
    await ctx.app.get(IndexerService).fullScan(team);
    expect(await live(team.id)).toEqual([]);
  });

  it('missing source or target folder is not_found', async () => {
    const { docs } = await tree();
    await expect(files.copy(home, home, '00000000-0000-4000-8000-000000000000', null, { onConflict: 'fail' })).rejects.toBeInstanceOf(SyncError);
    await expect(files.copy(home, home, docs.id, '00000000-0000-4000-8000-000000000000', { onConflict: 'fail' })).rejects.toMatchObject({ code: 'not_found' });
  });
});
