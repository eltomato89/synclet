import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createTestApp, createTestUser, personalSpace, TestContext } from '../../test/context';
import type { IndexSpace, IndexUser } from '../common/types';
import { FilesService } from '../files/files.service';
import { IndexerService } from '../indexer/indexer.service';
import { moveNoReplace } from '../files/fs-ops';
import { ItemStore } from '../journal/item-store';
import { JournalService } from '../journal/journal.service';
import { TrashService } from './trash.service';

const DAY = 24 * 3600 * 1000;

/** All entry names below `dir`, recursively, as relative paths. */
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    out.push(rel);
    if (d.isDirectory()) out.push(...(await tree(path.join(dir, d.name), rel)));
  }
  return out.sort();
}

describe('TrashService', () => {
  let ctx: TestContext; let files: FilesService; let trash: TrashService; let user: IndexUser; let space: IndexSpace; let root: string;
  const body = (s: string) => Readable.from([Buffer.from(s)]);

  async function setup(overrides = {}) {
    ctx = await createTestApp(overrides);
    files = ctx.app.get(FilesService);
    trash = ctx.app.get(TrashService);
    user = await createTestUser(ctx);
    space = personalSpace(ctx, user);
    root = path.join(ctx.config.dataRoot, user.username);
  }
  afterEach(async () => { jest.restoreAllMocks(); await ctx.close(); });

  /** Docs/Projekt/{a.txt, Sub/b.txt} – returns the rows. */
  async function project() {
    const docs = await files.createFolder(space, null, 'Docs');
    const proj = await files.createFolder(space, docs.id, 'Projekt');
    const a = await files.upload(space, proj.id, 'a.txt', body('alpha'), {});
    const sub = await files.createFolder(space, proj.id, 'Sub');
    const b = await files.upload(space, sub.id, 'b.txt', body('beta'), {});
    return { docs, proj, a, sub, b };
  }

  async function trashOf(itemId: string) {
    await files.pendingTrash();
    return ctx.prisma.trashEntry.findFirstOrThrow({ where: { itemId } });
  }

  const liveIds = async () => (await ctx.prisma.item.findMany({ where: { deletedAt: null }, orderBy: { path: 'asc' } })).map((i) => [i.path, i.id]);

  describe('with default retention', () => {
    beforeEach(() => setup());

    it('remove() writes a rich manifest and expiresAt = deletedAt + 30 d', async () => {
      const { proj, a } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      expect(e.expiresAt!.getTime() - e.deletedAt.getTime()).toBe(30 * DAY);
      const m = e.manifest as Array<Record<string, unknown>>;
      expect(m).toHaveLength(4);
      expect(m.find((x) => x.id === a.id)).toEqual({
        id: a.id, type: 'file', path: 'Docs/Projekt/a.txt', name: 'a.txt', mtime: a.mtime.toISOString(), size: 5, contentHash: a.contentHash,
      });
      const [wire] = await trash.list(space);
      expect(wire).toMatchObject({ id: e.id, itemId: `d_${proj.id}`, type: 'folder', name: 'Projekt', originalPath: 'Docs/Projekt', itemCount: 4, size: 9 });
    });

    it('restores a folder with its original ids, content and hashes', async () => {
      const { proj, a, sub, b } = await project();
      const before = await liveIds();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      const res = await trash.restore(space, e.id);
      expect(res).toMatchObject({ restoredTo: 'Docs/Projekt', renamed: false, item: { id: `d_${proj.id}`, name: 'Projekt' } });
      expect(await liveIds()).toEqual(before);
      expect(await readFile(path.join(root, 'Docs/Projekt/Sub/b.txt'), 'utf8')).toBe('beta');
      const ra = await ctx.prisma.item.findUniqueOrThrow({ where: { id: a.id } });
      expect(ra).toMatchObject({ contentHash: a.contentHash, version: 2, parentId: proj.id });
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: b.id } })).parentId).toBe(sub.id);
      expect(existsSync(path.join(ctx.config.metaRoot, 'trash', e.id))).toBe(false);
      expect(await ctx.prisma.trashEntry.count()).toBe(0);
      expect(await tree(root)).toEqual(['Docs', 'Docs/Projekt', 'Docs/Projekt/Sub', 'Docs/Projekt/Sub/b.txt', 'Docs/Projekt/a.txt']);
    });

    it('waits for a pending background move before restoring', async () => {
      const { a } = await project();
      await files.remove(space, a.id);
      const e = await ctx.prisma.trashEntry.findFirstOrThrow(); // no pendingTrash() on purpose
      const res = await trash.restore(space, e.id);
      expect(res.item.id).toBe(`f_${a.id}`);
      expect(await readFile(path.join(root, 'Docs/Projekt/a.txt'), 'utf8')).toBe('alpha');
    });

    it('409 conflict when the trash content is missing', async () => {
      const { a } = await project();
      await files.remove(space, a.id);
      const e = await trashOf(a.id);
      await ctx.prisma.trashEntry.update({ where: { id: e.id }, data: { storePath: path.join(ctx.config.metaRoot, 'trash', e.id, 'nope') } });
      await expect(trash.restore(space, e.id)).rejects.toMatchObject({ code: 'conflict', status: 409 });
      expect(await ctx.prisma.trashEntry.count()).toBe(1);
    });

    it('restores next to an occupying item under a free name, never overwriting (Review Focus 1)', async () => {
      const { docs, proj, a } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      const squatter = await files.createFolder(space, docs.id, 'projekt'); // case-insensitive clash
      await files.upload(space, squatter.id, 'a.txt', body('NEW'), {});
      // An unindexed entry on disk takes "Projekt (2)" as well.
      await mkdir(path.join(root, 'Docs', 'Projekt (2)'));
      await writeFile(path.join(root, 'Docs', 'Projekt (2)', 'host.txt'), 'host');
      const res = await trash.restore(space, e.id);
      expect(res).toMatchObject({ renamed: true, restoredTo: 'Docs/Projekt (3)', item: { id: `d_${proj.id}`, name: 'Projekt (3)' } });
      expect(await readFile(path.join(root, 'Docs/projekt/a.txt'), 'utf8')).toBe('NEW');
      expect(await readFile(path.join(root, 'Docs/Projekt (2)/host.txt'), 'utf8')).toBe('host');
      expect(await readFile(path.join(root, 'Docs/Projekt (3)/a.txt'), 'utf8')).toBe('alpha');
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: a.id } })).path).toBe('Docs/Projekt (3)/a.txt');
    });

    it('restores a file under a free name "x (2).txt"', async () => {
      const f = await files.upload(space, null, 'x.txt', body('old'), {});
      await files.remove(space, f.id);
      const e = await trashOf(f.id);
      await files.upload(space, null, 'x.txt', body('new'), {});
      const res = await trash.restore(space, e.id);
      expect(res).toMatchObject({ renamed: true, restoredTo: 'x (2).txt', item: { id: `f_${f.id}` } });
      expect(await readFile(path.join(root, 'x.txt'), 'utf8')).toBe('new');
      expect(await readFile(path.join(root, 'x (2).txt'), 'utf8')).toBe('old');
    });

    it('restores at the root when the original parent no longer exists', async () => {
      const { docs, proj, a } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      await files.remove(space, docs.id);
      await files.pendingTrash();
      const res = await trash.restore(space, e.id);
      expect(res).toMatchObject({ restoredTo: 'Projekt', renamed: false, item: { id: `d_${proj.id}`, parentId: 'root' } });
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: a.id } })).path).toBe('Projekt/a.txt');
      expect(await readFile(path.join(root, 'Projekt/a.txt'), 'utf8')).toBe('alpha');
    });

    it('keeps the original ids after the tombstones were purged', async () => {
      const { proj } = await project();
      const before = await liveIds();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      await ctx.app.get(ItemStore).purgeTombstones(new Date(Date.now() + 1));
      expect(await ctx.prisma.item.count({ where: { deletedAt: { not: null } } })).toBe(0);
      await trash.restore(space, e.id);
      expect(await liveIds()).toEqual(before);
      const a = await ctx.prisma.item.findFirstOrThrow({ where: { path: 'Docs/Projekt/a.txt' } });
      expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('gives a new id to an entry whose original id is live again', async () => {
      const { proj, a, b } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      await ctx.prisma.item.update({ where: { id: a.id }, data: { deletedAt: null, path: 'elsewhere.txt', name: 'elsewhere.txt', nameKey: 'elsewhere.txt', parentId: null } });
      await trash.restore(space, e.id);
      const restoredA = await ctx.prisma.item.findFirstOrThrow({ where: { path: 'Docs/Projekt/a.txt', deletedAt: null } });
      expect(restoredA.id).not.toBe(a.id);
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: a.id } })).path).toBe('elsewhere.txt');
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: b.id } })).deletedAt).toBeNull();
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: proj.id } })).deletedAt).toBeNull();
    });

    it('works with an old-format manifest ({id,type,path} only)', async () => {
      const { proj, a, b } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      const old = (e.manifest as Array<{ id: string; type: string; path: string }>).map(({ id, type, path: p }) => ({ id, type, path: p }));
      await ctx.prisma.trashEntry.update({ where: { id: e.id }, data: { manifest: old } });
      await ctx.app.get(ItemStore).purgeTombstones(new Date(Date.now() + 1));
      await trash.restore(space, e.id);
      for (const id of [proj.id, a.id, b.id]) expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    });

    it('gives new ids to entries on disk that are not in the manifest', async () => {
      const { proj } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      await writeFile(path.join(e.storePath, 'extra.txt'), 'x');
      await trash.restore(space, e.id);
      expect(await ctx.prisma.item.findFirst({ where: { path: 'Docs/Projekt/extra.txt', deletedAt: null } })).not.toBeNull();
    });

    it('copies across file systems via an ignored temp folder and keeps ids', async () => {
      const proto = TrashService.prototype as unknown as { moveIn(src: string, dst: string): Promise<void> };
      const seen: string[] = [];
      jest.spyOn(proto, 'moveIn').mockImplementation(async (src: string, dst: string) => {
        seen.push(src);
        if (src.startsWith(ctx.config.metaRoot)) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        return moveNoReplace(src, dst);
      });
      const { proj } = await project();
      const before = await liveIds();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      await trash.restore(space, e.id);
      expect(seen[0].startsWith(ctx.config.metaRoot)).toBe(true);
      expect(path.basename(path.dirname(seen[1]))).toMatch(/^\.synclet-tmp-[0-9a-f]+$/);
      expect(await liveIds()).toEqual(before);
      expect(await tree(root)).toEqual(['Docs', 'Docs/Projekt', 'Docs/Projekt/Sub', 'Docs/Projekt/Sub/b.txt', 'Docs/Projekt/a.txt']);
      expect(existsSync(path.join(ctx.config.metaRoot, 'trash', e.id))).toBe(false);
    });

    it.each(['direct', 'copy'])('a failure before commit (%s) leaves the entry intact and no temp names behind', async (mode) => {
      if (mode === 'copy') {
        const proto = TrashService.prototype as unknown as { moveIn(src: string, dst: string): Promise<void> };
        jest.spyOn(proto, 'moveIn').mockImplementation(async (src: string, dst: string) => {
          if (src.startsWith(ctx.config.metaRoot)) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
          return moveNoReplace(src, dst);
        });
      }
      const { proj } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      const storeBefore = await tree(e.storePath);
      jest.spyOn(ctx.app.get(JournalService), 'record').mockRejectedValueOnce(new Error('db down'));
      await expect(trash.restore(space, e.id)).rejects.toThrow('db down');
      expect(await tree(root)).toEqual(['Docs']);
      expect(await tree(e.storePath)).toEqual(storeBefore);
      expect(await ctx.prisma.trashEntry.count()).toBe(1);
      expect(await ctx.prisma.item.count({ where: { id: proj.id, deletedAt: null } })).toBe(0);
      // and a retry succeeds
      await trash.restore(space, e.id);
      expect(await tree(root)).toEqual(['Docs', 'Docs/Projekt', 'Docs/Projekt/Sub', 'Docs/Projekt/Sub/b.txt', 'Docs/Projekt/a.txt']);
    });

    it('ENOSPC while restoring answers 507, keeps the entry and leaves no temp folder', async () => {
      const proto = TrashService.prototype as unknown as { moveIn(src: string, dst: string): Promise<void> };
      jest.spyOn(proto, 'moveIn').mockRejectedValue(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
      const { proj } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      await expect(trash.restore(space, e.id)).rejects.toMatchObject({ status: 507, code: 'insufficient_storage' });
      expect(await tree(root)).toEqual(['Docs']);
      expect(await ctx.prisma.trashEntry.count()).toBe(1);
    });

    it('a failing copy removes its temp folder', async () => {
      const proto = TrashService.prototype as unknown as { moveIn(src: string, dst: string): Promise<void> };
      jest.spyOn(proto, 'moveIn').mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
      const { proj } = await project();
      await files.remove(space, proj.id);
      const e = await trashOf(proj.id);
      // The copy succeeds, but publishing it fails as well.
      await expect(trash.restore(space, e.id)).rejects.toBeTruthy();
      expect(await tree(root)).toEqual(['Docs']);
      expect(await ctx.prisma.trashEntry.count()).toBe(1);
    });

    it('rejects a concurrent second restore of the same entry and restores exactly once', async () => {
      const { a } = await project();
      await files.remove(space, a.id);
      const e = await trashOf(a.id);
      const results = await Promise.allSettled([trash.restore(space, e.id), trash.restore(space, e.id)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await tree(path.join(root, 'Docs/Projekt'))).toEqual(['Sub', 'Sub/b.txt', 'a.txt']);
    });

    it('deleteForever removes files and row; empty returns the count; other users get 404', async () => {
      const { a, b, docs } = await project();
      await files.remove(space, a.id);
      await files.remove(space, b.id);
      await files.remove(space, docs.id);
      const ea = await trashOf(a.id);
      await trash.deleteForever(space, ea.id);
      expect(existsSync(path.join(ctx.config.metaRoot, 'trash', ea.id))).toBe(false);
      expect(await ctx.prisma.trashEntry.count()).toBe(2);
      const bob = await createTestUser(ctx, 'bob');
      const eb = await trashOf(b.id);
      await expect(trash.deleteForever(personalSpace(ctx, bob), eb.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(trash.restore(personalSpace(ctx, bob), eb.id)).rejects.toMatchObject({ code: 'not_found' });
      expect(await trash.empty(personalSpace(ctx, bob))).toBe(0);
      expect(await trash.list(personalSpace(ctx, bob))).toEqual([]);
      expect(await trash.empty(space)).toBe(2);
      expect(await readdir(path.join(ctx.config.metaRoot, 'trash'))).toEqual([]);
      await expect(trash.deleteForever(space, 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('expire() removes entries past expiresAt and keeps younger ones', async () => {
      const f1 = await files.upload(space, null, 'old.txt', body('1'), {});
      const f2 = await files.upload(space, null, 'young.txt', body('2'), {});
      await files.remove(space, f1.id);
      await files.remove(space, f2.id);
      const old = await trashOf(f1.id);
      const young = await trashOf(f2.id);
      await ctx.prisma.trashEntry.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await trash.expire()).toBe(1);
      expect(existsSync(path.join(ctx.config.metaRoot, 'trash', old.id))).toBe(false);
      expect(existsSync(young.storePath)).toBe(true);
      expect((await ctx.prisma.trashEntry.findMany()).map((e) => e.id)).toEqual([young.id]);
      expect(await trash.expire(new Date(Date.now() + 31 * DAY))).toBe(1);
      expect(await ctx.prisma.trashEntry.count()).toBe(0);
    });
    it('restores a folder with 5,000 files well within the transaction timeout, keeping ids', async () => {
      const big = path.join(root, 'Big');
      await mkdir(path.join(big, 'Sub'), { recursive: true });
      for (let i = 0; i < 5000; i += 500) {
        await Promise.all(Array.from({ length: 500 }, (_, j) => writeFile(path.join(big, (i + j) % 2 ? 'Sub' : '', `f${i + j}.txt`), `${i + j}`)));
      }
      await ctx.app.get(IndexerService).fullScan(space);
      const folder = await ctx.prisma.item.findFirstOrThrow({ where: { path: 'Big' } });
      const before = await liveIds();
      expect(before).toHaveLength(5002);
      await files.remove(space, folder.id);
      const e = await trashOf(folder.id);
      // Half the tombstones purged: those rows are recreated, the rest revived.
      const purge = (await ctx.prisma.item.findMany({ where: { path: { startsWith: 'Big/Sub/' } }, select: { id: true } })).map((r) => r.id);
      await ctx.prisma.item.deleteMany({ where: { id: { in: purge } } });
      const t0 = Date.now();
      const res = await trash.restore(space, e.id);
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(res.item.id).toBe(`d_${folder.id}`);
      expect(await liveIds()).toEqual(before);
      const changes = await ctx.prisma.fileChange.count({ where: { op: 'upsert', itemId: { in: before.map(([, id]) => id) } } });
      expect(changes).toBeGreaterThanOrEqual(5002);
      const f = await ctx.prisma.item.findFirstOrThrow({ where: { path: 'Big/f0.txt' } });
      const disk = await ctx.prisma.item.findFirstOrThrow({ where: { path: 'Big/Sub/f1.txt' } });
      expect(f.version).toBe(2); // revived
      expect(disk.version).toBe(1); // recreated
      // Revived via raw UPDATE: mtime/ino/size match the disk exactly.
      const st = statSync(path.join(big, 'f0.txt'), { bigint: true });
      expect(f.mtime.getTime()).toBe(Number(st.mtimeMs));
      expect(f.ino).toBe(st.ino);
      expect(f.size).toBe(1n);
    }, 60_000);

    it('removeStore never removes anything but /meta/trash/<id> of a well-formed entry', async () => {
      const f1 = await files.upload(space, null, 'one.txt', body('1'), {});
      const f2 = await files.upload(space, null, 'two.txt', body('2'), {});
      await files.remove(space, f1.id);
      await files.remove(space, f2.id);
      const e1 = await trashOf(f1.id);
      const e2 = await trashOf(f2.id);
      // Corrupt row: e1 points at e2's directory.
      await ctx.prisma.trashEntry.update({ where: { id: e1.id }, data: { storePath: path.join(ctx.config.metaRoot, 'trash', e2.id) } });
      await trash.deleteForever(space, e1.id);
      expect(existsSync(e2.storePath)).toBe(true);
      expect(existsSync(path.join(ctx.config.metaRoot, 'trash', e1.id))).toBe(true); // left for the orphan sweep
      // Corrupt row pointing outside /meta/trash.
      await ctx.prisma.trashEntry.update({ where: { id: e2.id }, data: { storePath: path.join(root, 'victim.txt') } });
      await writeFile(path.join(root, 'victim.txt'), 'user data');
      await trash.deleteForever(space, e2.id);
      expect(await readFile(path.join(root, 'victim.txt'), 'utf8')).toBe('user data');
    });

    it('expire() backfills a missing expiresAt from deletedAt + retention', async () => {
      const f1 = await files.upload(space, null, 'old.txt', body('1'), {});
      const f2 = await files.upload(space, null, 'new.txt', body('2'), {});
      await files.remove(space, f1.id);
      await files.remove(space, f2.id);
      const old = await trashOf(f1.id);
      const fresh = await trashOf(f2.id);
      await ctx.prisma.trashEntry.update({ where: { id: old.id }, data: { expiresAt: null, deletedAt: new Date(Date.now() - 40 * DAY) } });
      await ctx.prisma.trashEntry.update({ where: { id: fresh.id }, data: { expiresAt: null } });
      expect(await trash.expire()).toBe(1);
      expect(existsSync(path.join(ctx.config.metaRoot, 'trash', old.id))).toBe(false);
      const kept = await ctx.prisma.trashEntry.findUniqueOrThrow({ where: { id: fresh.id } });
      expect(kept.expiresAt!.getTime() - kept.deletedAt.getTime()).toBe(30 * DAY);
    });

    it('expire() sweeps orphaned UUID directories in /meta/trash and nothing else', async () => {
      const f = await files.upload(space, null, 'kept.txt', body('k'), {});
      await files.remove(space, f.id);
      const e = await trashOf(f.id);
      const trashRoot = path.join(ctx.config.metaRoot, 'trash');
      const orphan = randomUUID();
      await mkdir(path.join(trashRoot, orphan, 'x'), { recursive: true });
      await writeFile(path.join(trashRoot, orphan, 'x', 'y.txt'), 'y');
      await mkdir(path.join(trashRoot, 'not-a-uuid'));
      await writeFile(path.join(trashRoot, randomUUID()), 'a file, not a directory');
      const outside = path.join(root, 'Outside');
      await mkdir(outside);
      await writeFile(path.join(outside, 'precious.txt'), 'p');
      const linked = randomUUID();
      await symlink(outside, path.join(trashRoot, linked));
      expect(await trash.expire()).toBe(0);
      const left = (await readdir(trashRoot)).sort();
      expect(left).not.toContain(orphan);
      expect(left).toContain(e.id);
      expect(left).toContain('not-a-uuid');
      expect(left).toContain(linked);
      expect(left).toHaveLength(4);
      expect(await readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('p');
      expect(existsSync(e.storePath)).toBe(true);
    });
  });

  describe('with trashRetentionDays: 0', () => {
    beforeEach(() => setup({ trashRetentionDays: 0 }));

    it('sets no expiresAt and never expires', async () => {
      const f = await files.upload(space, null, 'keep.txt', body('k'), {});
      await files.remove(space, f.id);
      const e = await trashOf(f.id);
      expect(e.expiresAt).toBeNull();
      expect((await trash.list(space))[0].expiresAt).toBeNull();
      expect(await trash.expire(new Date(Date.now() + 3650 * DAY))).toBe(0);
      expect(existsSync(e.storePath)).toBe(true);
      expect((await ctx.prisma.trashEntry.findUniqueOrThrow({ where: { id: e.id } })).expiresAt).toBeNull(); // no backfill
    });
  });
});
