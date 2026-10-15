import { mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestUser, itIfCaseSensitive, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { BusyPaths } from '../journal/busy-paths';
import { JournalService } from '../journal/journal.service';
import { IndexerService } from './indexer.service';

describe('IndexerService', () => {
  let ctx: TestContext; let indexer: IndexerService; let journal: JournalService; let user: IndexUser; let root: string;
  beforeEach(async () => {
    ctx = await createTestApp();
    indexer = ctx.app.get(IndexerService);
    journal = ctx.app.get(JournalService);
    user = await createTestUser(ctx);
    root = path.join(ctx.config.dataRoot, user.username);
  });
  afterEach(async () => { await ctx.close(); });

  const live = () => ctx.prisma.item.findMany({ where: { deletedAt: null }, orderBy: { path: 'asc' } });
  const byPath = async (p: string) => (await live()).find((i) => i.path === p)!;
  const changesFrom = async (cursor: string) => (await journal.changesSince(user.id, cursor, 1000)).entries;

  it('indexes a fresh tree recursively and journals every item', async () => {
    await mkdir(path.join(root, 'Docs/Sub'), { recursive: true });
    await writeFile(path.join(root, 'Docs/a.txt'), 'hello');
    await writeFile(path.join(root, 'Docs/Sub/b.txt'), 'world!');
    const stats = await indexer.fullScan(user);
    expect(stats).toMatchObject({ created: 4 });
    expect((await live()).map((i) => [i.path, i.type, Number(i.size)])).toEqual([
      ['Docs', 'folder', 0], ['Docs/Sub', 'folder', 0], ['Docs/Sub/b.txt', 'file', 6], ['Docs/a.txt', 'file', 5],
    ]);
    expect((await byPath('Docs/Sub/b.txt')).parentId).toBe((await byPath('Docs/Sub')).id);
    expect(await changesFrom('0')).toHaveLength(4);
  });

  it('is idempotent: a second scan journals nothing', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x');
    await indexer.fullScan(user);
    const cursor = await journal.currentCursor(user.id);
    expect(await indexer.fullScan(user)).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(await journal.currentCursor(user.id)).toBe(cursor);
  });

  it('keeps the ID on external rename and move (inode match)', async () => {
    await mkdir(path.join(root, 'A'));
    await mkdir(path.join(root, 'B'));
    await writeFile(path.join(root, 'A/doc.txt'), 'content');
    await indexer.fullScan(user);
    const id = (await byPath('A/doc.txt')).id;
    await rename(path.join(root, 'A/doc.txt'), path.join(root, 'B/renamed.txt'));
    const stats = await indexer.fullScan(user);
    expect(stats).toMatchObject({ moved: 1, created: 0 });
    const moved = await byPath('B/renamed.txt');
    expect(moved.id).toBe(id);
    expect(moved.parentId).toBe((await byPath('B')).id);
  });

  it('keeps folder and descendant IDs when a folder is moved externally', async () => {
    await mkdir(path.join(root, 'X/Inner'), { recursive: true });
    await writeFile(path.join(root, 'X/Inner/f.txt'), 'f');
    await mkdir(path.join(root, 'Target'));
    await indexer.fullScan(user);
    const before = await live();
    await rename(path.join(root, 'X'), path.join(root, 'Target/X2'));
    await indexer.fullScan(user);
    const after = await live();
    const idOf = (rows: typeof before, p: string) => rows.find((r) => r.path === p)!.id;
    expect(idOf(after, 'Target/X2')).toBe(idOf(before, 'X'));
    expect(idOf(after, 'Target/X2/Inner')).toBe(idOf(before, 'X/Inner'));
    expect(idOf(after, 'Target/X2/Inner/f.txt')).toBe(idOf(before, 'X/Inner/f.txt'));
  });

  it('keeps the ID and bumps version on editor-style save (temp file + rename over)', async () => {
    await writeFile(path.join(root, 'note.md'), 'v1');
    await indexer.fullScan(user);
    const before = await byPath('note.md');
    await writeFile(path.join(root, 'note.md.tmp~'), 'v2 longer');
    await rename(path.join(root, 'note.md.tmp~'), path.join(root, 'note.md'));
    await indexer.reconcileDir(user, '', { recursive: false });
    const after = await byPath('note.md');
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(before.version + 1);
    expect(Number(after.size)).toBe(9);
  });

  it('detects in-place content changes via size/mtime', async () => {
    await writeFile(path.join(root, 'a.txt'), 'one');
    await indexer.fullScan(user);
    await writeFile(path.join(root, 'a.txt'), 'two');
    await utimes(path.join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    expect(await indexer.fullScan(user)).toMatchObject({ updated: 1 });
  });

  it('tombstones deleted items and journals deletes for the subtree', async () => {
    await mkdir(path.join(root, 'D'));
    await writeFile(path.join(root, 'D/x.txt'), 'x');
    await indexer.fullScan(user);
    const cursor = await journal.currentCursor(user.id);
    await rm(path.join(root, 'D'), { recursive: true });
    expect(await indexer.fullScan(user)).toMatchObject({ deleted: 1 });
    expect(await live()).toEqual([]);
    expect(await changesFrom(cursor)).toHaveLength(2);
  });

  it('treats a type change at the same path as delete + create', async () => {
    await writeFile(path.join(root, 'thing'), 'file');
    await indexer.fullScan(user);
    const oldId = (await byPath('thing')).id;
    await rm(path.join(root, 'thing'));
    await mkdir(path.join(root, 'thing'));
    await indexer.fullScan(user);
    const now = await byPath('thing');
    expect(now.type).toBe('folder');
    expect(now.id).not.toBe(oldId);
  });

  it('skips ignored names, temp files and symlinks (Review Focus 4)', async () => {
    await writeFile(path.join(root, '.DS_Store'), 'x');
    await writeFile(path.join(root, '.synclet-tmp-abc'), 'x');
    await writeFile(path.join(root, 'keep.txt'), 'x');
    await symlink('/etc', path.join(root, 'evil'));
    await symlink(path.join(root, 'keep.txt'), path.join(root, 'link.txt'));
    await indexer.fullScan(user);
    expect((await live()).map((i) => i.path)).toEqual(['keep.txt']);
  });

  it('refuses to scan when the data root has no user folders (Review Focus 1)', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x');
    await indexer.fullScan(user);
    const cursor = await journal.currentCursor(user.id);
    await rm(root, { recursive: true }); // simulates an unmounted/empty volume
    expect(await indexer.fullScan(user)).toBeNull();
    expect(await journal.currentCursor(user.id)).toBe(cursor);
    expect(await live()).toHaveLength(1);
  });

  it('reconcileDir climbs to the nearest indexed ancestor for unknown directories', async () => {
    await indexer.fullScan(user);
    await mkdir(path.join(root, 'new/deep'), { recursive: true });
    await writeFile(path.join(root, 'new/deep/f.txt'), 'x');
    await indexer.reconcileDir(user, 'new/deep', { recursive: false });
    expect((await live()).map((i) => i.path)).toEqual(['new', 'new/deep', 'new/deep/f.txt']);
  });

  it('skips paths marked busy by the API', async () => {
    await writeFile(path.join(root, 'busy.txt'), 'x');
    const { BusyPaths } = await import('../journal/busy-paths');
    const release = ctx.app.get(BusyPaths).add(user.id, 'busy.txt');
    await indexer.fullScan(user);
    expect(await live()).toEqual([]);
    release();
  });

  it('never tombstones an indexed item whose path is busy (API move in flight)', async () => {
    await writeFile(path.join(root, 'moving.txt'), 'x');
    await indexer.fullScan(user);
    const id = (await byPath('moving.txt')).id;
    const cursor = await journal.currentCursor(user.id);
    const release = ctx.app.get(BusyPaths).add(user.id, 'moving.txt');
    await rm(path.join(root, 'moving.txt')); // the API has moved the file away but not yet committed
    expect(await indexer.fullScan(user)).toMatchObject({ deleted: 0 });
    expect((await byPath('moving.txt')).id).toBe(id);
    expect(await journal.currentCursor(user.id)).toBe(cursor);
    release();
  });

  it('keeps the ID on a case-only rename (also on case-insensitive file systems)', async () => {
    await writeFile(path.join(root, 'readme.txt'), 'x');
    await indexer.fullScan(user);
    const id = (await byPath('readme.txt')).id;
    await rename(path.join(root, 'readme.txt'), path.join(root, 'README.txt'));
    expect(await indexer.fullScan(user)).toMatchObject({ moved: 1, created: 0, deleted: 0 });
    expect((await live()).map((i) => [i.path, i.id])).toEqual([['README.txt', id]]);
  });

  it('pairs a move whose source directory is scanned first (tombstone resurrection)', async () => {
    await mkdir(path.join(root, 'A'));
    await mkdir(path.join(root, 'Z'));
    await writeFile(path.join(root, 'Z/f.txt'), 'payload');
    await indexer.fullScan(user);
    const id = (await byPath('Z/f.txt')).id;
    await rename(path.join(root, 'Z/f.txt'), path.join(root, 'A/f.txt'));
    await indexer.reconcileDir(user, 'Z', { recursive: false }); // source first: tombstones the row
    expect((await live()).map((i) => i.path)).toEqual(['A', 'Z']);
    await indexer.reconcileDir(user, 'A', { recursive: false }); // destination: resurrects it
    const moved = await byPath('A/f.txt');
    expect(moved.id).toBe(id);
    expect(moved.parentId).toBe((await byPath('A')).id);
  });

  it('does not pair a hard link with the still-present original', async () => {
    const { link } = await import('node:fs/promises');
    await writeFile(path.join(root, 'orig.txt'), 'x');
    await indexer.fullScan(user);
    const id = (await byPath('orig.txt')).id;
    await link(path.join(root, 'orig.txt'), path.join(root, 'hard.txt'));
    expect(await indexer.fullScan(user)).toMatchObject({ created: 1, moved: 0 });
    expect((await byPath('orig.txt')).id).toBe(id);
    expect((await byPath('hard.txt')).id).not.toBe(id);
  });

  itIfCaseSensitive('indexes case variants as separate items', async () => {
    await writeFile(path.join(root, 'a.txt'), '1');
    await writeFile(path.join(root, 'A.txt'), '2');
    await indexer.fullScan(user);
    expect((await live()).map((i) => i.name).sort()).toEqual(['A.txt', 'a.txt']);
  });
});
