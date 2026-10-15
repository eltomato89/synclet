import fsp, { chmod, link, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import type { AppConfig } from '../config';
import type { IndexUser } from '../common/types';
import { DerivativesGc } from '../derivatives/derivatives-gc';
import { DerivedStore } from '../derivatives/derived-store';
import { FilesService } from '../files/files.service';
import * as fsOps from '../files/fs-ops';
import { TrashService } from '../trash/trash.service';
import { VersionsService } from './versions.service';

const body = (s: string | Buffer) => Readable.from([Buffer.from(s)]);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** Every entry below `dir` (relative paths), recursively. */
async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory()) out.push(...(await walk(dir, r)));
  }
  return out.sort();
}

describe('Versions', () => {
  let ctx: TestContext; let files: FilesService; let versions: VersionsService; let user: IndexUser; let root: string;
  const setup = async (overrides: Partial<AppConfig> = {}) => {
    ctx = await createTestApp({ versions: true, ...overrides });
    files = ctx.app.get(FilesService);
    versions = ctx.app.get(VersionsService);
    user = await createTestUser(ctx);
    root = path.join(ctx.config.dataRoot, user.username);
  };
  afterEach(async () => { await ctx?.close(); });

  const versionsDir = () => path.join(ctx.config.metaRoot, 'versions');
  const rows = (itemId?: string) => ctx.prisma.fileVersion.findMany({ where: itemId ? { itemId } : {}, orderBy: { createdAt: 'asc' } });

  describe('service', () => {
    beforeEach(() => setup());

    it('PUT content captures exactly one version with the previous bytes and adds nothing to /data', async () => {
      const f = await files.upload(user, null, 'notes.txt', body('first'), {});
      const updated = await files.replaceContent(user, f.id, body('second!'), { ifMatchVersion: 1 });
      expect(updated.version).toBe(2);
      expect(await walk(root)).toEqual(['notes.txt']);
      expect(await readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('second!');
      const [v, ...more] = await rows(f.id);
      expect(more).toEqual([]);
      expect(v).toMatchObject({ itemId: f.id, ownerId: user.id, version: 1, sha: f.contentHash, size: 5n, source: 'api', createdBy: user.id });
      expect(v.mtime.getTime()).toBe(f.mtime.getTime());
      expect(v.storePath).toBe(path.join(versionsDir(), user.id, f.id, `1-${f.contentHash}`));
      expect(await readFile(v.storePath, 'utf8')).toBe('first');
      const listed = await versions.list(user, f.id);
      expect(listed).toEqual([expect.objectContaining({ id: v.id, version: 1, size: 5, sha256: f.contentHash, source: 'api', createdBy: { id: user.id, displayName: 'alice' } })]);
    });

    it('two PUTs within one second are both captured; prune then keeps one per 2 s bucket', async () => {
      const f = await files.upload(user, null, 'a.txt', body('v1'), {});
      await files.replaceContent(user, f.id, body('v2'), { ifMatchVersion: null });
      await files.replaceContent(user, f.id, body('v3'), { ifMatchVersion: null });
      const both = await rows(f.id);
      expect(both.map((r) => r.version)).toEqual([1, 2]);
      expect(await Promise.all(both.map((r) => readFile(r.storePath, 'utf8')))).toEqual(['v1', 'v2']);
      expect(both[1].createdAt.getTime() - both[0].createdAt.getTime()).toBeLessThan(2000);
      const res = await versions.prune(new Date(both[1].createdAt.getTime() + 1000));
      expect(res.expired).toBe(1);
      const left = await rows(f.id);
      expect(left.map((r) => r.version)).toEqual([2]);
      await expect(stat(both[0].storePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('v3');
    });

    it('prune keeps versions in their retention buckets (older ones thinned out)', async () => {
      const f = await files.upload(user, null, 'a.txt', body('x'), {});
      for (let i = 0; i < 4; i++) await files.replaceContent(user, f.id, body(`y${i}`), { ifMatchVersion: null });
      const all = await rows(f.id);
      // Spread them: 1 h, 1 h 10 min, 3 h, 5 h ago.
      const now = new Date();
      const ages = [5 * 3600, 3 * 3600, 70 * 60, 3600].map((s) => new Date(now.getTime() - s * 1000));
      for (let i = 0; i < all.length; i++) await ctx.prisma.fileVersion.update({ where: { id: all[i].id }, data: { createdAt: ages[i] } });
      await versions.prune(now);
      expect((await rows(f.id)).map((r) => r.version)).toEqual([1, 2, 4]); // 70 min is within an hour of 1 h
    });

    it('restore round-trip: current becomes a version, restored bytes current, same id, version + 1, journaled', async () => {
      const f = await files.upload(user, null, 'doc.txt', body('original'), {});
      await files.replaceContent(user, f.id, body('edited'), { ifMatchVersion: 1 });
      const [v1] = await rows(f.id);
      await ctx.prisma.item.update({ where: { id: f.id }, data: { officeKey: 'session-1' } });
      const cursor = await ctx.prisma.fileChange.aggregate({ _max: { seq: true } });
      const restored = await versions.restore(user, f.id, v1.id);
      expect(restored.id).toBe(f.id);
      expect(restored.version).toBe(3);
      expect(restored.contentHash).toBe(f.contentHash);
      expect(restored.officeKey).toBeNull(); // an open office session must not overwrite the restore silently
      expect(await readFile(path.join(root, 'doc.txt'), 'utf8')).toBe('original');
      expect(await walk(root)).toEqual(['doc.txt']);
      const all = await rows(f.id);
      expect(all.map((r) => [r.version, r.source])).toEqual([[1, 'api'], [2, 'restore']]);
      expect(await readFile(all[1].storePath, 'utf8')).toBe('edited');
      expect(await readFile(all[0].storePath, 'utf8')).toBe('original'); // the restored version stays
      const changes = await ctx.prisma.fileChange.findMany({ where: { seq: { gt: cursor._max.seq ?? 0n } } });
      expect(changes).toEqual([expect.objectContaining({ itemId: f.id, op: 'upsert' })]);
    });

    it('capture stores createdBy null for an unknown or malformed editor id instead of failing', async () => {
      const f = await files.upload(user, null, 'o.docx', body('1'), {});
      const item = await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } });
      const abs = path.join(root, 'o.docx');
      for (const by of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', user.id]) {
        await ctx.prisma.$transaction((tx) => versions.capture(tx, user, item, abs, 'office', by));
      }
      expect((await rows(f.id)).map((r) => r.createdBy ?? 'null').sort()).toEqual(['null', 'null', user.id].sort());
      expect(await readFile(abs, 'utf8')).toBe('1');
    });

    it('versions a 0-byte file', async () => {
      const f = await files.upload(user, null, 'empty.txt', body(''), {});
      await files.replaceContent(user, f.id, body('now with content'), { ifMatchVersion: 1 });
      const [v] = await rows(f.id);
      expect(v.size).toBe(0n);
      expect((await stat(v.storePath)).size).toBe(0);
      const restored = await versions.restore(user, f.id, v.id);
      expect(Number(restored.size)).toBe(0);
      expect(await readFile(path.join(root, 'empty.txt'), 'utf8')).toBe('');
    });

    it('versions follow the item id across rename and move', async () => {
      const folder = await files.createFolder(user, null, 'Sub');
      const f = await files.upload(user, null, 'a.txt', body('one'), {});
      await files.replaceContent(user, f.id, body('two'), { ifMatchVersion: null });
      await files.update(user, f.id, { name: 'b.txt', parentId: folder.id });
      const listed = await versions.list(user, f.id);
      expect(listed).toHaveLength(1);
      const { downloadName, abs } = await versions.openRead(user, f.id, listed[0].id);
      expect(downloadName).toBe('b (v1).txt');
      expect(await readFile(abs, 'utf8')).toBe('one');
    });

    it('another user gets 404 for list, download and restore', async () => {
      const f = await files.upload(user, null, 'a.txt', body('one'), {});
      await files.replaceContent(user, f.id, body('two'), { ifMatchVersion: null });
      const [v] = await rows(f.id);
      const bob = await createTestUser(ctx, 'bob');
      await expect(versions.list(bob, f.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(versions.openRead(bob, f.id, v.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(versions.restore(bob, f.id, v.id)).rejects.toMatchObject({ code: 'not_found' });
      // A version id of another item is not reachable through this item either.
      const g = await files.upload(user, null, 'g.txt', body('g'), {});
      await expect(versions.openRead(user, g.id, v.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('trash restore keeps versions; delete forever removes version files and rows', async () => {
      const trash = ctx.app.get(TrashService);
      const folder = await files.createFolder(user, null, 'Dir');
      const f = await files.upload(user, folder.id, 'a.txt', body('one'), {});
      await files.replaceContent(user, f.id, body('two'), { ifMatchVersion: null });
      const [v] = await rows(f.id);
      await files.remove(user, folder.id);
      await files.pendingTrash();
      expect(await rows(f.id)).toHaveLength(1);
      let [entry] = await trash.list(user);
      await trash.restore(user, entry.id);
      expect((await versions.list(user, f.id)).map((x) => x.id)).toEqual([v.id]);
      await files.remove(user, folder.id);
      await files.pendingTrash();
      [entry] = await trash.list(user);
      await trash.deleteForever(user, entry.id);
      expect(await rows(f.id)).toEqual([]);
      await expect(stat(path.join(versionsDir(), user.id, f.id))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('emptying the trash and trash expiry remove versions', async () => {
      const trash = ctx.app.get(TrashService);
      const a = await files.upload(user, null, 'a.txt', body('1'), {});
      const b = await files.upload(user, null, 'b.txt', body('1'), {});
      for (const f of [a, b]) await files.replaceContent(user, f.id, body('2'), { ifMatchVersion: null });
      await files.remove(user, a.id);
      await files.remove(user, b.id);
      await files.pendingTrash();
      const [eb] = await trash.list(user);
      await ctx.prisma.trashEntry.update({ where: { id: eb.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await trash.expire()).toBe(1);
      expect((await rows()).map((r) => r.itemId)).toEqual([a.id]);
      expect(await trash.empty(user)).toBe(1);
      expect(await rows()).toEqual([]);
      expect(await walk(versionsDir()).then((l) => l.filter((p) => p.split('/').length === 2))).toEqual([]);
    });

    it('prune removes versions of items deleted on the host once their row is gone', async () => {
      const f = await files.upload(user, null, 'a.txt', body('1'), {});
      const keep = await files.upload(user, null, 'k.txt', body('1'), {});
      for (const x of [f, keep]) await files.replaceContent(user, x.id, body('2'), { ifMatchVersion: null });
      await ctx.prisma.item.delete({ where: { id: f.id } }); // tombstone purged after a host delete
      const res = await versions.prune();
      expect(res.orphaned).toBe(1);
      expect((await rows()).map((r) => r.itemId)).toEqual([keep.id]);
      await expect(stat(path.join(versionsDir(), user.id, f.id))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('GC keeps derivatives of a content hash referenced only by a version', async () => {
      const f = await files.upload(user, null, 'p.txt', body('picture'), {});
      const sha = f.contentHash!;
      const derived = ctx.app.get(DerivedStore);
      const thumb = derived.pathFor(sha, 'thumb', 256);
      await mkdir(path.dirname(thumb), { recursive: true });
      await writeFile(thumb, 'webp');
      await writeFile(derived.pathFor(sha, 'thumb', 1024), 'webp'); // complete, so GC never requeues it
      await ctx.prisma.derivativeJob.create({ data: { sha, kind: 'thumb', status: 'done' } });
      await files.replaceContent(user, f.id, body('other'), { ifMatchVersion: null });
      const gc = ctx.app.get(DerivativesGc);
      await gc.run();
      expect(await readFile(thumb, 'utf8')).toBe('webp');
      expect(await ctx.prisma.derivativeJob.count({ where: { sha } })).toBe(1);
      // Once the version is gone, so is the thumbnail.
      await versions.deleteForItems(user.id, [f.id]);
      await gc.run();
      await expect(stat(thumb)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('capture failure (versions dir not writable) aborts the replace and leaves the current file untouched', async () => {
      const f = await files.upload(user, null, 'safe.txt', body('precious'), {});
      // A file where the version store should be: mkdir fails even for root.
      await writeFile(versionsDir(), 'in the way');
      await expect(files.replaceContent(user, f.id, body('new'), { ifMatchVersion: 1 })).rejects.toThrow();
      expect(await readFile(path.join(root, 'safe.txt'), 'utf8')).toBe('precious');
      expect(await walk(root)).toEqual(['safe.txt']);
      const row = await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } });
      expect(row.version).toBe(1);
      expect(await rows()).toEqual([]);
    });

    (isRoot ? it.skip : it)('capture failure with a read-only versions dir aborts the replace (no temp left)', async () => {
      const f = await files.upload(user, null, 'safe.txt', body('precious'), {});
      await mkdir(versionsDir(), { recursive: true });
      await chmod(versionsDir(), 0o555);
      try {
        await expect(files.replaceContent(user, f.id, body('new'), { ifMatchVersion: 1 })).rejects.toMatchObject({ code: 'EACCES' });
        expect(await readFile(path.join(root, 'safe.txt'), 'utf8')).toBe('precious');
        expect(await walk(root)).toEqual(['safe.txt']);
        expect(await walk(versionsDir())).toEqual([]);
        expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).version).toBe(1);
      } finally {
        await chmod(versionsDir(), 0o755);
      }
    });

    it('copies (with hash) when hard links are not possible, leaving no temp behind', async () => {
      const f = await files.upload(user, null, 'x.txt', body('cross-fs'), {});
      await ctx.prisma.item.update({ where: { id: f.id }, data: { contentHash: null } }); // not hashed yet
      const spy = jest.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
      try {
        await files.replaceContent(user, f.id, body('new'), { ifMatchVersion: 1 });
      } finally {
        spy.mockRestore();
      }
      const [v] = await rows(f.id);
      expect(v.storePath).toBe(path.join(versionsDir(), user.id, f.id, '1-nohash'));
      expect(v.sha).toBe(f.contentHash);
      expect(await readFile(v.storePath, 'utf8')).toBe('cross-fs');
      expect(v.mtime.getTime()).toBe(f.mtime.getTime());
      expect(Math.abs((await stat(v.storePath)).mtime.getTime() - f.mtime.getTime())).toBeLessThanOrEqual(1);
      expect((await readdir(versionsDir())).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    });

    it('a leftover file of a rolled-back capture is replaced, a referenced one never', async () => {
      const f = await files.upload(user, null, 'a.txt', body('one'), {});
      const dir = path.join(versionsDir(), user.id, f.id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `1-${f.contentHash}`), 'stale');
      await files.replaceContent(user, f.id, body('two'), { ifMatchVersion: 1 });
      const [v] = await rows(f.id);
      expect(await readFile(v.storePath, 'utf8')).toBe('one');
    });

    describe('capture outside the user lock', () => {
      /** Regular files in the version store (relative paths), temps included. */
      const storedFiles = async () => {
        const out: string[] = [];
        for (const rel of await walk(versionsDir())) if ((await stat(path.join(versionsDir(), rel))).isFile()) out.push(rel);
        return out;
      };

      it('a slow copy of the current content does not hold the lock: another op of the same user proceeds', async () => {
        const f = await files.upload(user, null, 'big.bin', body('old content'), {});
        let entered!: () => void; const inCopy = new Promise<void>((r) => { entered = r; });
        let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
        const proto = Object.getPrototypeOf(versions) as { copyHashed: (s: string, d: string) => Promise<string> };
        const orig = proto.copyHashed;
        const copy = jest.spyOn(proto, 'copyHashed').mockImplementation(async function (this: unknown, src: string, dst: string) {
          entered(); await gate; return orig.call(this, src, dst);
        });
        const linkSpy = jest.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
        try {
          const put = files.replaceContent(user, f.id, body('new content'), { ifMatchVersion: 1 });
          await inCopy;
          // Same user, mutating, while the copy hangs: must not wait for it.
          const folder = await Promise.race([files.createFolder(user, null, 'during'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('blocked by the capture')), 5000))]);
          expect(folder.name).toBe('during');
          release();
          expect((await put).version).toBe(2);
        } finally {
          release(); copy.mockRestore(); linkSpy.mockRestore();
        }
        const [v] = await rows(f.id);
        expect(await readFile(v.storePath, 'utf8')).toBe('old content');
        expect(await readFile(path.join(root, 'big.bin'), 'utf8')).toBe('new content');
      });

      it('a failure after the DB writes but before the final rename leaves the current file and no version row', async () => {
        const f = await files.upload(user, null, 'keep.txt', body('current'), {});
        const spy = jest.spyOn(fsOps, 'replaceAtomic').mockRejectedValueOnce(new Error('disk gone'));
        try {
          await expect(files.replaceContent(user, f.id, body('next'), { ifMatchVersion: 1 })).rejects.toThrow('disk gone');
        } finally {
          spy.mockRestore();
        }
        expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('current');
        expect(await walk(root)).toEqual(['keep.txt']);
        expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).version).toBe(1);
        expect(await rows()).toEqual([]);
        expect(await storedFiles()).toEqual([]); // the published copy was withdrawn, no temp left
      });

      /** Makes the next replace transaction fail at COMMIT (after its callback ran), optionally after really committing. */
      const failCommitOnce = (reallyCommit: boolean) => {
        const orig = ctx.prisma.$transaction.bind(ctx.prisma) as (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>;
        return jest.spyOn(ctx.prisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, o?: unknown) =>
          reallyCommit
            ? orig(fn, o).then(() => { throw new Error('connection lost after COMMIT'); })
            : orig(async (tx) => { await fn(tx); throw new Error('COMMIT failed'); }, o)) as never);
      };

      it('a COMMIT failing after the final rename keeps the version file and records its row again', async () => {
        const f = await files.upload(user, null, 'c.txt', body('previous'), {});
        const spy = failCommitOnce(false);
        try {
          await expect(files.replaceContent(user, f.id, body('new'), { ifMatchVersion: 1 })).rejects.toThrow('COMMIT failed');
        } finally {
          spy.mockRestore();
        }
        expect(await readFile(path.join(root, 'c.txt'), 'utf8')).toBe('new'); // renamed before the failed commit
        const [v, ...more] = await rows(f.id);
        expect(more).toEqual([]);
        expect(v).toMatchObject({ version: 1, sha: f.contentHash, source: 'api' });
        expect(await readFile(v.storePath, 'utf8')).toBe('previous');
        expect(await storedFiles()).toEqual([`${user.id}/${f.id}/${path.basename(v.storePath)}`]);
      });

      it('an ambiguous COMMIT (committed, error reported) keeps the version file and adds no second row', async () => {
        const f = await files.upload(user, null, 'c.txt', body('previous'), {});
        const spy = failCommitOnce(true);
        try {
          await expect(files.replaceContent(user, f.id, body('new'), { ifMatchVersion: 1 })).rejects.toThrow('connection lost');
        } finally {
          spy.mockRestore();
        }
        const all = await rows(f.id);
        expect(all).toHaveLength(1);
        expect(await readFile(all[0].storePath, 'utf8')).toBe('previous');
        expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).version).toBe(2);
      });

      /** Simulates a host edit that the indexer picked up right after `prepare` (row matches disk again). */
      const hostEdit = async (itemId: string, abs: string, content: string) => {
        await writeFile(abs, content);
        const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
        await utimes(abs, t, t);
        const st = await stat(abs, { bigint: true });
        await ctx.prisma.item.update({ where: { id: itemId }, data: { size: st.size, mtime: new Date(Number(st.mtimeMs)), ino: st.ino, dev: st.dev, contentHash: null, version: { increment: 1 } } });
      };

      it('a host change between prepare and commit is detected and the version is prepared again', async () => {
        const f = await files.upload(user, null, 'h.txt', body('one'), {});
        const abs = path.join(root, 'h.txt');
        const orig = versions.prepare.bind(versions);
        let calls = 0;
        const spy = jest.spyOn(versions, 'prepare').mockImplementation(async (u, id) => {
          const p = await orig(u, id);
          if (++calls === 1) await hostEdit(f.id, abs, 'host edit');
          return p;
        });
        try {
          const updated = await files.replaceContent(user, f.id, body('api'), { ifMatchVersion: null });
          expect(updated.version).toBe(3);
        } finally {
          spy.mockRestore();
        }
        expect(calls).toBe(2);
        const all = await rows(f.id);
        expect(all.map((r) => r.version)).toEqual([2]);
        expect(await readFile(all[0].storePath, 'utf8')).toBe('host edit'); // never the stale 'one'
        expect(await readFile(abs, 'utf8')).toBe('api');
        expect(await storedFiles()).toEqual([`${user.id}/${f.id}/${path.basename(all[0].storePath)}`]);
      });

      it('a file that keeps changing during capture yields 412 and is left as the host wrote it', async () => {
        const f = await files.upload(user, null, 'h.txt', body('one'), {});
        const abs = path.join(root, 'h.txt');
        const orig = versions.prepare.bind(versions);
        let n = 0;
        const spy = jest.spyOn(versions, 'prepare').mockImplementation(async (u, id) => {
          const p = await orig(u, id);
          await hostEdit(f.id, abs, `host ${++n}`);
          return p;
        });
        try {
          await expect(files.replaceContent(user, f.id, body('api'), { ifMatchVersion: null })).rejects.toMatchObject({ code: 'conflict' });
        } finally {
          spy.mockRestore();
        }
        expect(await readFile(abs, 'utf8')).toBe('host 2');
        expect(await rows()).toEqual([]);
        expect(await storedFiles()).toEqual([]);
        expect(await walk(root)).toEqual(['h.txt']);
      });

      it('a file with another hard link is copied: edits through that link never change the version', async () => {
        const f = await files.upload(user, null, 'a.txt', body('original'), {});
        const other = path.join(ctx.config.dataRoot, 'other-link');
        await link(path.join(root, 'a.txt'), other); // the user's own second name for the inode
        try {
          await files.replaceContent(user, f.id, body('replaced'), { ifMatchVersion: 1 });
          const [v] = await rows(f.id);
          expect((await stat(v.storePath)).ino).not.toBe((await stat(other)).ino);
          await writeFile(other, 'changed via the other link'); // in place, same inode as the old file
          expect(await readFile(v.storePath, 'utf8')).toBe('original');
        } finally {
          await rm(other, { force: true });
        }
      });

      it('office save and restore go through commitReplace with their sources', async () => {
        const commit = jest.spyOn(files as unknown as { commitReplace: (...a: unknown[]) => Promise<unknown> }, 'commitReplace');
        const f = await files.upload(user, null, 'o.docx', body('v1'), {});
        const saved = await files.saveOfficeContent(user, f.id, body('v2 from office'), { key: 'k1', baseVersion: 1, by: user.id, conflictName: (n) => `${n} (conflict)` });
        expect(saved.outcome).toBe('replaced');
        const [v1] = await rows(f.id);
        expect(v1).toMatchObject({ version: 1, source: 'office', createdBy: user.id });
        await versions.restore(user, f.id, v1.id);
        expect(commit.mock.calls.map((c) => c[6])).toEqual(['office', 'restore']);
        expect((await rows(f.id)).map((r) => r.source)).toEqual(['office', 'restore']);
        expect(await readFile(path.join(root, 'o.docx'), 'utf8')).toBe('v1');
        commit.mockRestore();
      });
    });

    it('max bytes evicts the oldest versions but always keeps the newest per item', async () => {
      await ctx.close();
      await setup({ versionsMaxBytes: 10 });
      const a = await files.upload(user, null, 'a.txt', body('aaaa'), {});
      const b = await files.upload(user, null, 'b.txt', body('bbbbbbbb'), {});
      await files.replaceContent(user, a.id, body('AAAA'), { ifMatchVersion: null }); // keeps a v1 'aaaa' (4 B)
      await files.replaceContent(user, a.id, body('aaaaa'), { ifMatchVersion: null }); // keeps a v2 'AAAA' (4 B)
      await files.replaceContent(user, b.id, body('B'), { ifMatchVersion: null }); // keeps b v1 (8 B)
      await files.replaceContent(user, a.id, body('x'), { ifMatchVersion: null }); // keeps a v3 'aaaaa' (5 B)
      // Days apart, so the retention buckets keep all four.
      const all = await rows();
      for (const [i, days] of [30, 20, 15, 10].entries()) {
        await ctx.prisma.fileVersion.update({ where: { id: all[i].id }, data: { createdAt: new Date(Date.now() - days * 86400_000) } });
      }
      // 21 B > 10 B: evict oldest first – a v1 (17), a v2 (13); a v3 and b v1 are the newest of their
      // items and stay although the user is still above the limit.
      const res = await versions.prune();
      expect(res.evicted).toBe(2);
      const left = await rows();
      expect(left.map((r) => [r.itemId, r.version]).sort()).toEqual([[a.id, 3], [b.id, 1]].sort());
      expect(await walk(path.join(versionsDir(), user.id, a.id))).toEqual([`3-${left.find((r) => r.itemId === a.id)!.sha}`]);
    });

    it('prune sweeps stray files and temps older than an hour, never referenced ones', async () => {
      const f = await files.upload(user, null, 'a.txt', body('one'), {});
      await files.replaceContent(user, f.id, body('two'), { ifMatchVersion: null });
      const [v] = await rows(f.id);
      const stray = path.join(path.dirname(v.storePath), '9-nohash');
      await writeFile(stray, 'x');
      await writeFile(path.join(versionsDir(), '.tmp-abc'), 'x');
      expect((await versions.prune(new Date(Date.now() + 1000))).stray).toBe(0); // too young
      const res = await versions.prune(new Date(Date.now() + 2 * 3600 * 1000));
      expect(res.stray).toBe(2);
      expect(await readFile(v.storePath, 'utf8')).toBe('one');
      await expect(stat(stray)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('versions off', () => {
    beforeEach(() => setup({ versions: false }));

    it('creates no rows or files and prune is a no-op', async () => {
      const f = await files.upload(user, null, 'a.txt', body('1'), {});
      await files.replaceContent(user, f.id, body('2'), { ifMatchVersion: null });
      expect(await rows()).toEqual([]);
      await expect(stat(versionsDir())).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(versions.list(user, f.id)).rejects.toMatchObject({ code: 'not_found', message: 'versions disabled' });
    });
  });
});

describe('Versions HTTP API', () => {
  let ctx: TestContext; let token: string;
  const api = (method: string, url: string, opts: { body?: string; headers?: Record<string, string>; auth?: boolean } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: {
        ...(opts.auth === false ? {} : { authorization: `Bearer ${token}` }),
        ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
  const start = async (versions: boolean) => {
    ctx = await createTestApp({ versions, officeUrl: versions ? 'https://office.example.com' : null });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken;
  };
  afterEach(async () => { await ctx.close(); });

  it('lists, downloads (also with a download token) and restores versions', async () => {
    await start(true);
    const item = (await api('POST', '/items/upload?parentId=root&name=Report.final.txt', { body: 'v1 bytes' })).json();
    expect((await api('PUT', `/items/${item.id}/content`, { body: 'v2', headers: { 'if-match': '"v1"' } })).statusCode).toBe(200);
    const list = await api('GET', `/items/${item.id}/versions`);
    expect(list.statusCode).toBe(200);
    const [v] = list.json();
    expect(v).toMatchObject({ version: 1, size: 8, source: 'api', createdBy: { displayName: 'Jens' } });
    const dl = await api('GET', `/items/${item.id}/versions/${v.id}/content`);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('v1 bytes');
    expect(dl.headers['content-disposition']).toContain('filename="Report.final (v1).txt"');
    const { token: dt } = (await api('POST', `/items/${item.id}/download-token`)).json();
    const viaDt = await api('GET', `/items/${item.id}/versions/${v.id}/content?dt=${encodeURIComponent(dt)}`, { auth: false });
    expect(viaDt.body).toBe('v1 bytes');
    const restored = await api('POST', `/items/${item.id}/versions/${v.id}/restore`);
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: item.id, version: 3, size: 8 });
    expect((await api('GET', `/items/${item.id}/content`)).body).toBe('v1 bytes');
    expect((await api('GET', `/items/${item.id}/versions`)).json().map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect((await api('GET', `/items/${item.id}/versions/00000000-0000-4000-8000-000000000000/content`)).statusCode).toBe(404);
    expect((await api('GET', '/capabilities')).json()).toEqual({ versions: true, office: { enabled: true, url: 'https://office.example.com' } });
  });

  it('a failed capture answers 500 and keeps the current content', async () => {
    await start(true);
    const item = (await api('POST', '/items/upload?parentId=root&name=a.txt', { body: 'keep me' })).json();
    await writeFile(path.join(ctx.config.metaRoot, 'versions'), 'in the way');
    const res = await api('PUT', `/items/${item.id}/content`, { body: 'new', headers: { 'if-match': '"v1"' } });
    expect(res.statusCode).toBe(500);
    expect((await api('GET', `/items/${item.id}/content`)).body).toBe('keep me');
    expect(await readdir(path.join(ctx.config.dataRoot, 'jens'))).toEqual(['a.txt']);
  });

  it('versions off: routes answer 404 versions disabled, capabilities say so', async () => {
    await start(false);
    const item = (await api('POST', '/items/upload?parentId=root&name=a.txt', { body: '1' })).json();
    await api('PUT', `/items/${item.id}/content`, { body: '2', headers: { 'if-match': '*' } });
    const list = await api('GET', `/items/${item.id}/versions`);
    expect(list.statusCode).toBe(404);
    expect(list.json()).toMatchObject({ code: 'not_found', message: 'versions disabled' });
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await api('GET', `/items/${item.id}/versions/${id}/content`)).json().message).toBe('versions disabled');
    expect((await api('POST', `/items/${item.id}/versions/${id}/restore`)).json().message).toBe('versions disabled');
    expect((await api('GET', '/capabilities')).json()).toEqual({ versions: false, office: { enabled: false, url: null } });
    expect(await ctx.prisma.fileVersion.count()).toBe(0);
  });

  it('requires authentication and rejects folder ids', async () => {
    await start(true);
    expect((await api('GET', '/items/f_00000000-0000-4000-8000-000000000000/versions', { auth: false })).statusCode).toBe(401);
    expect((await api('GET', '/capabilities', { auth: false })).statusCode).toBe(401);
    expect((await api('GET', '/items/root/versions')).statusCode).toBe(400);
  });
});
