import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createTestApp, createTestUser, itIfCaseSensitive, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { IndexerService } from '../indexer/indexer.service';
import { JournalService } from '../journal/journal.service';
import { FilesService } from './files.service';

describe('FilesService', () => {
  let ctx: TestContext; let files: FilesService; let user: IndexUser; let root: string;
  beforeEach(async () => {
    ctx = await createTestApp();
    files = ctx.app.get(FilesService);
    user = await createTestUser(ctx);
    root = path.join(ctx.config.dataRoot, user.username);
  });
  afterEach(async () => { await ctx.close(); });

  const body = (s: string) => Readable.from([Buffer.from(s)]);
  const visible = async (dir = root) => (await readdir(dir)).sort();

  it('creates folders and files exactly as named on disk', async () => {
    const folder = await files.createFolder(user, null, 'Projekte 2026');
    const file = await files.upload(user, folder.id, 'Angebot ü.txt', body('hallo'), {});
    expect(await visible()).toEqual(['Projekte 2026']);
    expect(await readFile(path.join(root, 'Projekte 2026', 'Angebot ü.txt'), 'utf8')).toBe('hallo');
    expect(file.path).toBe('Projekte 2026/Angebot ü.txt');
    expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(file.size)).toBe(5);
  });

  it('rejects invalid names and missing parents', async () => {
    await expect(files.createFolder(user, null, 'a/b')).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(files.createFolder(user, '00000000-0000-4000-8000-000000000000', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('handles name conflicts case-insensitively with fail or rename', async () => {
    await files.upload(user, null, 'Report.pdf', body('1'), {});
    await expect(files.upload(user, null, 'report.PDF', body('2'), {})).rejects.toMatchObject({ code: 'name_conflict' });
    const renamed = await files.upload(user, null, 'report.PDF', body('2'), { onConflict: 'rename' });
    expect(renamed.name).toBe('report (2).PDF');
  });

  it('upload never overwrites an unindexed file on disk (Review Focus 3)', async () => {
    await writeFile(path.join(root, 'fresh.txt'), 'external');
    await expect(files.upload(user, null, 'fresh.txt', body('mine'), {})).rejects.toMatchObject({ code: 'name_conflict' });
    expect(await readFile(path.join(root, 'fresh.txt'), 'utf8')).toBe('external');
    const r = await files.upload(user, null, 'fresh.txt', body('mine'), { onConflict: 'rename' });
    expect(r.name).toBe('fresh (2).txt');
    expect(await readFile(path.join(root, 'fresh.txt'), 'utf8')).toBe('external');
  });

  it('aborted upload leaves nothing behind (Review Focus 5)', async () => {
    const stream = new PassThrough();
    const p = files.upload(user, null, 'big.bin', stream, {});
    stream.write(Buffer.alloc(1024));
    stream.destroy(new Error('client went away'));
    await expect(p).rejects.toThrow();
    expect(await visible()).toEqual([]);
    expect(await ctx.prisma.item.count()).toBe(0);
  });

  it('replaceContent enforces If-Match and bumps the version', async () => {
    const f = await files.upload(user, null, 'a.txt', body('v1'), {});
    await expect(files.replaceContent(user, f.id, body('x'), { ifMatchVersion: 99 })).rejects.toMatchObject({ code: 'conflict' });
    const v2 = await files.replaceContent(user, f.id, body('version two'), { ifMatchVersion: f.version });
    expect(v2.version).toBe(f.version + 1);
    expect(v2.id).toBe(f.id);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('version two');
  });

  it('replaceContent detects an unindexed external edit (Review Focus 2)', async () => {
    const f = await files.upload(user, null, 'a.txt', body('v1'), {});
    await writeFile(path.join(root, 'a.txt'), 'edited on host, longer');
    await expect(files.replaceContent(user, f.id, body('client'), { ifMatchVersion: f.version })).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('edited on host, longer');
  });

  it('applies modifiedAt to the file on disk', async () => {
    const when = new Date('2024-05-01T10:00:00.000Z');
    const f = await files.upload(user, null, 'dated.txt', body('x'), { modifiedAt: when });
    expect((await stat(path.join(root, 'dated.txt'))).mtime.toISOString()).toBe(when.toISOString());
    expect(f.mtime.toISOString()).toBe(when.toISOString());
  });

  it('renames and moves folders, keeping IDs and rewriting descendant paths', async () => {
    const a = await files.createFolder(user, null, 'A');
    const b = await files.createFolder(user, null, 'B');
    const f = await files.upload(user, a.id, 'x.txt', body('x'), {});
    const moved = await files.update(user, a.id, { name: 'A2', parentId: b.id });
    expect(moved.path).toBe('B/A2');
    expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).path).toBe('B/A2/x.txt');
    expect(await visible(path.join(root, 'B', 'A2'))).toEqual(['x.txt']);
    await expect(files.update(user, b.id, { parentId: moved.id })).rejects.toMatchObject({ code: 'invalid_move' });
  });

  it('rename refuses to clobber and allows case-only renames of the same item', async () => {
    await files.upload(user, null, 'one.txt', body('1'), {});
    const two = await files.upload(user, null, 'two.txt', body('2'), {});
    await expect(files.update(user, two.id, { name: 'ONE.txt' })).rejects.toMatchObject({ code: 'name_conflict' });
    const r = await files.update(user, two.id, { name: 'Two.txt' });
    expect(r.name).toBe('Two.txt');
  });

  it('update with a stale etag fails with conflict', async () => {
    const f = await files.upload(user, null, 'a.txt', body('1'), {});
    await expect(files.update(user, f.id, { name: 'b.txt' }, { ifMatchEtag: 'v42' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('remove moves the subtree to /meta/trash and journals deletes', async () => {
    const a = await files.createFolder(user, null, 'A');
    await files.upload(user, a.id, 'x.txt', body('x'), {});
    const cursor = await ctx.app.get(JournalService).currentCursor(user.id);
    await files.remove(user, a.id);
    expect(await visible()).toEqual([]);
    const entry = await ctx.prisma.trashEntry.findFirstOrThrow();
    expect(entry.originalPath).toBe('A');
    expect(await readFile(path.join(entry.storePath, 'x.txt'), 'utf8')).toBe('x');
    expect(entry.storePath.startsWith(ctx.config.metaRoot)).toBe(true);
    const changes = await ctx.app.get(JournalService).changesSince(user.id, cursor, 100);
    expect(changes.entries).toHaveLength(2);
  });

  it('API writes produce no indexer echo', async () => {
    const a = await files.createFolder(user, null, 'A');
    await files.upload(user, a.id, 'x.txt', body('x'), {});
    await files.update(user, a.id, { name: 'B' });
    const journal = ctx.app.get(JournalService);
    const cursor = await journal.currentCursor(user.id);
    expect(await ctx.app.get(IndexerService).fullScan(user)).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(await journal.currentCursor(user.id)).toBe(cursor);
  });

  it('never leaves temp files in the user folder', async () => {
    await mkdir(path.join(root, 'sub'));
    await files.upload(user, null, 'a.txt', body('x'), {});
    expect((await visible()).filter((n) => n.startsWith('.synclet-tmp-'))).toEqual([]);
  });
  it('aborted upload before streaming starts leaves nothing behind', async () => {
    const stream = new PassThrough();
    const p = files.upload(user, null, 'early.bin', stream, {});
    stream.destroy(new Error('client went away immediately'));
    await expect(p).rejects.toThrow();
    expect(await visible()).toEqual([]);
    expect(await ctx.prisma.item.count()).toBe(0);
  });

  it('rejects uploads above maxUploadBytes without leaving anything', async () => {
    await ctx.close();
    ctx = await createTestApp({ maxUploadBytes: 4 });
    files = ctx.app.get(FilesService);
    user = await createTestUser(ctx);
    root = path.join(ctx.config.dataRoot, user.username);
    await expect(files.upload(user, null, 'big.txt', body('12345'), {})).rejects.toMatchObject({ code: 'too_large' });
    expect(await visible()).toEqual([]);
  });

  it('case-only rename changes the exact on-disk name and causes no indexer echo', async () => {
    const f = await files.upload(user, null, 'two.txt', body('2'), {});
    const d = await files.createFolder(user, null, 'docs');
    await files.update(user, f.id, { name: 'Two.txt' });
    await files.update(user, d.id, { name: 'Docs' });
    expect(await visible()).toEqual(['Docs', 'Two.txt']);
    const journal = ctx.app.get(JournalService);
    const cursor = await journal.currentCursor(user.id);
    expect(await ctx.app.get(IndexerService).fullScan(user)).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(await journal.currentCursor(user.id)).toBe(cursor);
  });

  itIfCaseSensitive('case-only rename never clobbers a differently-cased unindexed sibling', async () => {
    const f = await files.upload(user, null, 'two.txt', body('mine'), {});
    await writeFile(path.join(root, 'Two.txt'), 'external');
    await expect(files.update(user, f.id, { name: 'Two.txt' })).rejects.toMatchObject({ code: 'name_conflict' });
    expect(await readFile(path.join(root, 'Two.txt'), 'utf8')).toBe('external');
    expect(await readFile(path.join(root, 'two.txt'), 'utf8')).toBe('mine');
  });

  it('rename never clobbers an unindexed file on disk', async () => {
    const f = await files.upload(user, null, 'a.txt', body('mine'), {});
    await writeFile(path.join(root, 'b.txt'), 'external');
    await expect(files.update(user, f.id, { name: 'b.txt' })).rejects.toMatchObject({ code: 'name_conflict' });
    expect(await readFile(path.join(root, 'b.txt'), 'utf8')).toBe('external');
    expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).name).toBe('a.txt');
  });

  it('replaceContent does not resurrect a file deleted on the host', async () => {
    const f = await files.upload(user, null, 'a.txt', body('v1'), {});
    await rm(path.join(root, 'a.txt'));
    await expect(files.replaceContent(user, f.id, body('client'), { ifMatchVersion: f.version })).rejects.toMatchObject({ code: 'not_found' });
    expect(await visible()).toEqual([]);
  });

  it('remove of a file produces no indexer echo and the indexer is not blocked afterwards', async () => {
    const f = await files.upload(user, null, 'a.txt', body('x'), {});
    await files.remove(user, f.id);
    const journal = ctx.app.get(JournalService);
    const cursor = await journal.currentCursor(user.id);
    expect(await ctx.app.get(IndexerService).fullScan(user)).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(await journal.currentCursor(user.id)).toBe(cursor);
    await writeFile(path.join(root, 'a.txt'), 'new on host');
    expect(await ctx.app.get(IndexerService).fullScan(user)).toMatchObject({ created: 1 });
  });

  it('upload and createFolder fail with not_found when the parent vanished on the host', async () => {
    const d = await files.createFolder(user, null, 'gone');
    await rm(path.join(root, 'gone'), { recursive: true });
    await expect(files.upload(user, d.id, 'x.txt', body('x'), {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(files.createFolder(user, d.id, 'sub')).rejects.toMatchObject({ code: 'not_found' });
    expect(await visible()).toEqual([]);
  });

  it('openRead returns the absolute path of a live file only', async () => {
    const d = await files.createFolder(user, null, 'D');
    const f = await files.upload(user, d.id, 'x.txt', body('x'), {});
    const { abs } = await files.openRead(user, f.id);
    expect(await readFile(abs, 'utf8')).toBe('x');
    await expect(files.openRead(user, d.id)).rejects.toMatchObject({ code: 'invalid_request' });
    await files.remove(user, f.id);
    await expect(files.openRead(user, f.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
