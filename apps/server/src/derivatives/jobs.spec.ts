import type { Item } from '@prisma/client';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import type { IndexUser } from '../common/types';
import { statEntry } from '../files/fs-ops';
import { nameKey } from '../common/names';
import { WorkerRunner } from '../worker/worker-runner';
import { DerivativesGc } from './derivatives-gc';
import { DerivedStore } from './derived-store';
import { HashBackfill } from './hash';
import { JobsService } from './jobs.service';
import { SearchLanguage } from '../search/search-language';
import { TextIndexer } from './text-index';
import { Thumbnailer } from './thumbnails';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const fakeSha = (c: string) => c.repeat(64);

describe('derivative worker (DB)', () => {
  let ctx: TestContext; let user: IndexUser;
  let jobs: JobsService; let hash: HashBackfill; let store: DerivedStore; let thumbs: Thumbnailer; let runner: WorkerRunner;

  beforeEach(async () => {
    ctx = await createTestApp();
    user = await createTestUser(ctx, 'alice');
    jobs = new JobsService(ctx.prisma, ctx.config);
    hash = new HashBackfill(ctx.prisma, ctx.config);
    store = ctx.app.get(DerivedStore);
    thumbs = new Thumbnailer(store, ctx.config);
    runner = new WorkerRunner(ctx.config, hash, jobs, thumbs, new TextIndexer(ctx.prisma, new SearchLanguage(ctx.prisma, ctx.config)));
  });
  afterEach(async () => { await ctx.close(); });

  /** Puts `content` (or a fixture) on disk and indexes it like the indexer would (no hash unless given). */
  async function addFile(name: string, content: string | Buffer | { fixture: string }, opts: { hash?: boolean; owner?: IndexUser } = {}): Promise<Item> {
    const owner = opts.owner ?? user;
    const abs = path.join(ctx.config.dataRoot, owner.username, name);
    if (typeof content === 'object' && 'fixture' in content) await copyFile(path.join(FIXTURES, content.fixture), abs);
    else await writeFile(abs, content);
    const st = await statEntry(abs);
    return ctx.prisma.item.create({
      data: {
        spaceId: owner.id, parentId: null, type: 'file', name, nameKey: nameKey(name), path: name,
        size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev,
        contentHash: opts.hash ? sha256(await readFile(abs)) : null,
      },
    });
  }

  const job = (sha: string, kind: 'thumb' | 'text' = 'thumb') => ctx.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha, kind } } });

  describe('hash backfill', () => {
    it('sets missing hashes without bumping versions or journaling', async () => {
      const a = await addFile('a.txt', 'alpha');
      const b = await addFile('b.bin', Buffer.alloc(300_000, 1));
      const scope = await ctx.prisma.syncScope.findUniqueOrThrow({ where: { spaceId: user.id } });
      expect(await hash.hashMissing()).toBe(2);
      const rows = await ctx.prisma.item.findMany({ orderBy: { name: 'asc' } });
      expect(rows.map((r) => r.contentHash)).toEqual([sha256('alpha'), sha256(Buffer.alloc(300_000, 1))]);
      expect(rows.map((r) => r.version)).toEqual([a.version, b.version]);
      expect(rows.map((r) => r.updatedAt)).toEqual([a.updatedAt, b.updatedAt]);
      expect(await ctx.prisma.syncScope.findUniqueOrThrow({ where: { spaceId: user.id } })).toEqual(scope);
      expect(await ctx.prisma.fileChange.count()).toBe(0);
      expect(await hash.hashMissing()).toBe(0);
    });

    it('hashes rows recorded without an inode', async () => {
      const c = await addFile('c.txt', 'gamma');
      await ctx.prisma.item.update({ where: { id: c.id }, data: { ino: null, dev: null } });
      expect(await hash.hashMissing()).toBe(1);
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: c.id } })).contentHash).toBe(sha256('gamma'));
    });

    it('the skip list evicts its oldest entry when full', async () => {
      hash.maxSkipped = 2;
      const rows: Item[] = [];
      for (const n of ['1.txt', '2.txt', '3.txt']) rows.push(await addFile(n, n));
      for (const r of rows) await ctx.prisma.item.update({ where: { id: r.id }, data: { size: 999n } }); // disk differs → skipped
      expect(await hash.hashMissing()).toBe(0);
      const skipped = () => [...(hash as unknown as { skipped: Map<string, number> }).skipped.keys()];
      expect(skipped().length).toBe(2);
      const [evicted] = rows.filter((r) => !skipped().includes(r.id));
      // The evicted file is tried again (and re-enters the list, evicting the next oldest).
      expect(await hash.hashMissing()).toBe(0);
      expect(skipped()).toContain(evicted.id);
      expect(skipped().length).toBe(2);
    });

    it('skips a file that changed while it was hashed', async () => {
      const a = await addFile('a.txt', 'alpha');
      hash.afterHash = async (row) => {
        // The indexer records a host edit meanwhile.
        await ctx.prisma.item.update({ where: { id: row.id }, data: { size: 99n, version: { increment: 1 } } });
      };
      expect(await hash.hashMissing()).toBe(0);
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: a.id } })).contentHash).toBeNull();
    });

    it('skips files whose disk state differs from the row (not indexed yet) and symlink escapes', async () => {
      const a = await addFile('a.txt', 'alpha');
      await writeFile(path.join(ctx.config.dataRoot, 'alice', 'a.txt'), 'changed on the host');
      await writeFile(path.join(ctx.config.dataRoot, 'secret.txt'), 'outside');
      await symlink(path.join(ctx.config.dataRoot, 'secret.txt'), path.join(ctx.config.dataRoot, 'alice', 'link.txt'));
      await ctx.prisma.item.create({ data: { spaceId: user.id, type: 'file', name: 'link.txt', nameKey: 'link.txt', path: 'link.txt', size: 7n, mtime: new Date() } });
      expect(await hash.hashMissing()).toBe(0);
      expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: a.id } })).contentHash).toBeNull();
      expect(await ctx.prisma.item.count({ where: { contentHash: { not: null } } })).toBe(0);
    });
  });

  describe('queue', () => {
    it('enqueueMissing is idempotent and shares one job across files with the same hash', async () => {
      await addFile('a.png', { fixture: 'sample.png' }, { hash: true });
      await addFile('copy.png', { fixture: 'sample.png' }, { hash: true });
      await addFile('notes.md', '# hi', { hash: true });
      await addFile('song.mp3', { fixture: 'sample.mp3' }, { hash: true });
      await addFile('unhashed.jpg', 'x');
      const doc = await addFile('doc.pdf', { fixture: 'sample.pdf' }, { hash: true });
      expect(await jobs.enqueueMissing()).toBe(4); // png thumb, md text, pdf thumb + text
      expect(await jobs.enqueueMissing()).toBe(0);
      const all = await ctx.prisma.derivativeJob.findMany({ orderBy: [{ sha: 'asc' }, { kind: 'asc' }] });
      expect(all.map((j) => `${j.sha === doc.contentHash ? 'pdf' : j.sha === sha256('# hi') ? 'md' : 'png'}:${j.kind}`).sort())
        .toEqual(['md:text', 'pdf:text', 'pdf:thumb', 'png:thumb']);
      expect(all.every((j) => j.status === 'pending' && j.attempts === 0)).toBe(true);
    });

    it('ignores trashed/tombstoned files and files above previewMaxBytes', async () => {
      const t = await addFile('gone.png', { fixture: 'sample.png' }, { hash: true });
      await ctx.prisma.item.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
      await addFile('big.jpg', Buffer.alloc(2048, 1), { hash: true });
      jobs = new JobsService(ctx.prisma, { ...ctx.config, previewMaxBytes: 1024 });
      expect(await jobs.enqueueMissing()).toBe(0);
    });

    it('two concurrent claimers never get the same job', async () => {
      for (let i = 0; i < 20; i++) {
        await ctx.prisma.derivativeJob.create({ data: { sha: sha256(String(i)), kind: 'thumb' } });
      }
      const other = new JobsService(ctx.prisma, ctx.config);
      const seen: string[] = [];
      for (let round = 0; round < 4; round++) {
        const [x, y] = await Promise.all([jobs.claim('thumb', 3), other.claim('thumb', 3)]);
        seen.push(...x.map((j) => j.sha), ...y.map((j) => j.sha));
      }
      expect(seen.length).toBe(20);
      expect(new Set(seen).size).toBe(20);
      const rows = await ctx.prisma.derivativeJob.findMany();
      expect(rows.every((r) => r.status === 'running' && r.attempts === 1 && r.lockedAt)).toBe(true);
      expect(await jobs.claim('text', 5)).toEqual([]);
    });

    it('stale running jobs are re-claimable after 10 minutes; exhausted ones are not', async () => {
      const ago = (min: number) => new Date(Date.now() - min * 60_000);
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('a'), kind: 'thumb', status: 'running', attempts: 1, lockedAt: ago(11) } });
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('b'), kind: 'thumb', status: 'running', attempts: 1, lockedAt: ago(5) } });
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('c'), kind: 'thumb', status: 'pending', attempts: 3 } });
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('d'), kind: 'thumb', status: 'done', attempts: 1 } });
      const claimed = await jobs.claim('thumb', 10);
      expect(claimed.map((j) => j.sha)).toEqual([fakeSha('a')]);
      expect(claimed[0].attempts).toBe(2);
    });

    it('stale running jobs with exhausted attempts are marked failed instead of staying running', async () => {
      const ago = (min: number) => new Date(Date.now() - min * 60_000);
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('a'), kind: 'thumb', status: 'running', attempts: 3, lockedAt: ago(11) } });
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('b'), kind: 'thumb', status: 'running', attempts: 3, lockedAt: ago(1) } });
      expect(await jobs.claim('thumb', 10)).toEqual([]);
      expect(await job(fakeSha('a'))).toMatchObject({ status: 'failed', lockedAt: null, lastError: expect.stringMatching(/attempts exhausted/) });
      expect(await job(fakeSha('b'))).toMatchObject({ status: 'running' }); // still within its lock
    });

    it('retryOrFail returns to pending until attempts are used up; release does not count', async () => {
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('a'), kind: 'thumb' } });
      for (let i = 1; i <= 3; i++) {
        const [j] = await jobs.claim('thumb', 1);
        expect(j.attempts).toBe(i);
        await jobs.retryOrFail(j.sha, 'thumb', `boom ${i}`);
      }
      expect(await job(fakeSha('a'))).toMatchObject({ status: 'failed', lastError: 'boom 3', lockedAt: null });
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('b'), kind: 'thumb' } });
      const [b] = await jobs.claim('thumb', 1);
      await jobs.release(b.sha, 'thumb');
      expect(await job(fakeSha('b'))).toMatchObject({ status: 'pending', attempts: 0, lockedAt: null });
    });

    it('sourceFor prefers a qualifying name, re-verifies the file and rejects symlink escapes', async () => {
      const txt = await addFile('same.txt', { fixture: 'sample.png' }, { hash: true });
      const png = await addFile('same.png', { fixture: 'sample.png' }, { hash: true });
      const src = await jobs.sourceFor(png.contentHash!, 'thumb');
      expect(src?.name).toBe('same.png');
      expect(src?.abs.endsWith(path.join('alice', 'same.png'))).toBe(true);
      // Changed on disk (size differs from the row) → that copy is skipped.
      await writeFile(path.join(ctx.config.dataRoot, 'alice', 'same.png'), 'different');
      expect((await jobs.sourceFor(png.contentHash!, 'thumb'))?.name).toBe('same.txt');
      await writeFile(path.join(ctx.config.dataRoot, 'alice', 'same.txt'), 'different');
      expect(await jobs.sourceFor(txt.contentHash!, 'thumb')).toBeNull();
      // A symlink pointing outside the user root is never followed.
      await copyFile(path.join(FIXTURES, 'sample.png'), path.join(ctx.config.dataRoot, 'outside.png'));
      await symlink(path.join(ctx.config.dataRoot, 'outside.png'), path.join(ctx.config.dataRoot, 'alice', 'link.png'));
      const st = await statEntry(path.join(ctx.config.dataRoot, 'outside.png'));
      await ctx.prisma.item.create({ data: { spaceId: user.id, type: 'file', name: 'link.png', nameKey: 'link.png', path: 'link.png', size: st.size, mtime: st.mtime, contentHash: fakeSha('e') } });
      expect(await jobs.sourceFor(fakeSha('e'), 'thumb')).toBeNull();
    });
  });

  describe('worker loop', () => {
    it('hashes, enqueues and thumbnails in one pass, then idles', async () => {
      const png = await addFile('pic.png', { fixture: 'sample.png' });
      await addFile('song.mp3', { fixture: 'sample.mp3' });
      expect(await runner.tick()).toBe(true);
      const sha = (await ctx.prisma.item.findUniqueOrThrow({ where: { id: png.id } })).contentHash!;
      expect(await job(sha)).toMatchObject({ status: 'done', attempts: 1, lockedAt: null, meta: { sizes: [256, 1024], width: 80, height: 60 } });
      expect(await store.has(store.pathFor(sha, 'thumb', 256))).toBe(true);
      expect(await store.has(store.pathFor(sha, 'thumb', 1024))).toBe(true);
      expect(await ctx.prisma.derivativeJob.count({ where: { kind: 'text' } })).toBe(0);
      expect(await runner.tick()).toBe(false); // idle
    });

    it('a decompression bomb ends as failed without crashing the worker', async () => {
      const abs = path.join(ctx.config.dataRoot, 'alice', 'bomb.png');
      await sharp({ create: { width: 12000, height: 12000, channels: 3, background: '#000' }, limitInputPixels: false })
        .png({ palette: true, colours: 2, compressionLevel: 9 }).toFile(abs);
      const st = await statEntry(abs);
      const sha = fakeSha('f');
      await ctx.prisma.item.create({ data: { spaceId: user.id, type: 'file', name: 'bomb.png', nameKey: 'bomb.png', path: 'bomb.png', size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha } });
      await addFile('ok.png', { fixture: 'sample.png' }, { hash: true });
      await runner.tick();
      expect(await job(sha)).toMatchObject({ status: 'failed', attempts: 1 });
      expect((await job(sha))!.lastError).toMatch(/pixel limit/i);
      expect(await ctx.prisma.derivativeJob.count({ where: { status: 'done' } })).toBe(1); // the other job still ran
      expect(await readdir(path.join(store.root, '.tmp'))).toEqual([]);
    }, 60_000);

    it('a job whose content is gone is dropped and is no work', async () => {
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('a'), kind: 'thumb' } });
      expect(await runner.tick()).toBe(false);
      expect(await job(fakeSha('a'))).toBeNull();
    });

    it('a job whose file is unreadable right now is deferred 15 min, not re-run in a hot loop', async () => {
      const png = await addFile('pic.png', { fixture: 'sample.png' }, { hash: true });
      await writeFile(path.join(ctx.config.dataRoot, 'alice', 'pic.png'), 'edited on the host, not indexed yet');
      expect(await runner.tick()).toBe(true); // the job was enqueued (claimed and deferred in the same pass)
      expect(await runner.tick()).toBe(false); // nothing claimable: no work
      const j = await job(png.contentHash!);
      expect(j).toMatchObject({ status: 'pending', attempts: 0, lastError: 'no readable source file' });
      expect(j!.lockedAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(await jobs.claim('thumb', 5)).toEqual([]); // not before lockedAt
      // Due again after the delay.
      await ctx.prisma.derivativeJob.update({ where: { sha_kind: { sha: png.contentHash!, kind: 'thumb' } }, data: { lockedAt: new Date(Date.now() - 1000) } });
      expect((await jobs.claim('thumb', 5)).map((x) => x.sha)).toEqual([png.contentHash]);
    });

    it('run() sleeps between passes when the only job has no usable source', async () => {
      await addFile('pic.png', { fixture: 'sample.png' }, { hash: true });
      await writeFile(path.join(ctx.config.dataRoot, 'alice', 'pic.png'), 'changed');
      const tick = jest.spyOn(runner, 'tick');
      const running = runner.run();
      await new Promise((r) => setTimeout(r, 500));
      runner.stop();
      await running;
      // Pass 1 enqueues (work), pass 2 finds nothing claimable → the loop sleeps 2 s.
      expect(tick).toHaveBeenCalledTimes(2);
      await expect(tick.mock.results[1].value).resolves.toBe(false);
    });

    it('enqueueMissing runs only after hashing, on a content signal, or every 5 minutes', async () => {
      let clock = 1_000_000;
      runner.now = () => clock;
      const enqueue = jest.spyOn(jobs, 'enqueueMissing');
      await runner.tick();
      expect(enqueue).toHaveBeenCalledTimes(1); // first pass
      await runner.tick();
      clock += 4 * 60_000;
      await runner.tick();
      expect(enqueue).toHaveBeenCalledTimes(1); // idle: no scan
      clock += 60_000;
      await runner.tick();
      expect(enqueue).toHaveBeenCalledTimes(2); // 5 min elapsed
      await ctx.prisma.syncScope.update({ where: { spaceId: user.id }, data: { seq: { increment: 1 } } }); // server journaled a change
      await runner.tick();
      expect(enqueue).toHaveBeenCalledTimes(3);
      await runner.tick();
      expect(enqueue).toHaveBeenCalledTimes(3);
      await addFile('new.png', { fixture: 'sample.png' }); // unhashed: the backfill hashes it
      await runner.tick();
      expect(enqueue).toHaveBeenCalledTimes(4);
      expect(await ctx.prisma.derivativeJob.count({ where: { status: 'done' } })).toBe(1);
    });

    it('stop() makes run() return; unstarted claims are released', async () => {
      await ctx.prisma.derivativeJob.create({ data: { sha: fakeSha('a'), kind: 'thumb' } });
      const [claimed] = await jobs.claim('thumb', 1);
      runner.stop();
      await runner.processThumb(claimed);
      expect(await job(fakeSha('a'))).toMatchObject({ status: 'pending', attempts: 0 });
      await runner.run(); // returns at once
    });
  });

  describe('derivatives GC', () => {
    it('removing the text of a dead hash also removes its finished text job (re-extracted when the content returns)', async () => {
      const sha = fakeSha('f');
      await ctx.prisma.derivativeJob.createMany({ data: [{ sha, kind: 'text', status: 'done' }, { sha, kind: 'thumb', status: 'done' }] });
      await ctx.prisma.itemText.create({ data: { sha, content: 'gone' } });
      const gc = ctx.app.get(DerivativesGc);
      // Race: the hash is still referenced while the job pass runs and gone by the text pass.
      const real = gc.liveShas.bind(gc);
      jest.spyOn(gc, 'liveShas').mockImplementationOnce(async (batch) => new Set(batch)).mockImplementation(real);
      const res = await gc.run();
      expect(res.texts).toBe(1);
      expect(await ctx.prisma.itemText.count()).toBe(0);
      expect(await job(sha, 'text')).toBeNull();
      expect(await job(sha, 'thumb')).not.toBeNull(); // left for the job pass of the next run
    });

    it('requeues done thumbnail jobs whose files are missing (e.g. /meta/derived deleted)', async () => {
      const intact = await addFile('a.png', { fixture: 'sample.png' }, { hash: true });
      const lost = await addFile('b.png', 'other bytes', { hash: true });
      const half = fakeSha('9');
      await ctx.prisma.derivativeJob.createMany({
        data: [
          { sha: intact.contentHash!, kind: 'thumb', status: 'done', attempts: 1 },
          { sha: lost.contentHash!, kind: 'thumb', status: 'done', attempts: 2 },
          { sha: lost.contentHash!, kind: 'text', status: 'done', attempts: 1 },
          { sha: half, kind: 'thumb', status: 'done', attempts: 1 },
        ],
      });
      for (const size of [256, 1024] as const) await store.writeAtomic(store.pathFor(intact.contentHash!, 'thumb', size), Buffer.from('x'));
      await store.writeAtomic(store.pathFor(half, 'thumb', 256), Buffer.from('x')); // 1024 missing
      await ctx.prisma.trashEntry.create({ // keeps `half` referenced
        data: { spaceId: user.id, itemId: '00000000-0000-4000-8000-000000000003', type: 'file', name: 'h.png', originalPath: 'h.png', size: 1n, storePath: '/z',
          manifest: [{ id: 'h', type: 'file', path: 'h.png', name: 'h.png', mtime: new Date().toISOString(), size: 1, contentHash: half }] },
      });
      const res = await ctx.app.get(DerivativesGc).run();
      expect(res.requeued).toBe(2);
      expect(await job(intact.contentHash!, 'thumb')).toMatchObject({ status: 'done' });
      expect(await job(lost.contentHash!, 'thumb')).toMatchObject({ status: 'pending', attempts: 0, lockedAt: null });
      expect(await job(lost.contentHash!, 'text')).toMatchObject({ status: 'done' }); // text lives in the DB
      expect(await job(half, 'thumb')).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('keeps shas of live items, trash manifests and unfinished jobs; removes others and their job rows', async () => {
      const live = await addFile('live.png', { fixture: 'sample.png' }, { hash: true });
      const trashed = fakeSha('b'); const inFlight = fakeSha('c'); const dead = fakeSha('d'); const oldFormat = fakeSha('e');
      await ctx.prisma.trashEntry.create({
        data: {
          spaceId: user.id, itemId: '00000000-0000-4000-8000-000000000001', type: 'folder', name: 'Old', originalPath: 'Old', size: 1n, storePath: '/x',
          manifest: [{ id: 'x', type: 'folder', path: 'Old' }, { id: 'y', type: 'file', path: 'Old/a.png', name: 'a.png', mtime: new Date().toISOString(), size: 1, contentHash: trashed }],
        },
      });
      await ctx.prisma.trashEntry.create({
        data: { spaceId: user.id, itemId: '00000000-0000-4000-8000-000000000002', type: 'file', name: 'o', originalPath: 'o', size: 1n, storePath: '/y', manifest: [{ id: 'z', type: 'file', path: oldFormat }] },
      });
      await ctx.prisma.derivativeJob.createMany({
        data: [
          { sha: live.contentHash!, kind: 'thumb', status: 'done' },
          { sha: trashed, kind: 'thumb', status: 'done' },
          { sha: inFlight, kind: 'thumb', status: 'running', lockedAt: new Date() },
          { sha: dead, kind: 'thumb', status: 'done' },
          { sha: dead, kind: 'text', status: 'unsupported' },
          { sha: oldFormat, kind: 'thumb', status: 'failed' },
        ],
      });
      await ctx.prisma.itemText.createMany({ data: [live.contentHash!, trashed, inFlight, dead, oldFormat].map((sha) => ({ sha, content: `text ${sha}` })) });
      for (const s of [live.contentHash!, trashed, inFlight, dead, oldFormat]) {
        for (const size of [256, 1024] as const) await store.writeAtomic(store.pathFor(s, 'thumb', size), Buffer.from('x'));
      }
      // Stale temp leftovers (> 1 h) go, fresh ones (a write in progress) stay.
      const old = new Date(Date.now() - 2 * 3600_000);
      await mkdir(path.join(store.root, '.tmp', 'job-old'), { recursive: true });
      await utimes(path.join(store.root, '.tmp', 'job-old'), old, old);
      await mkdir(path.join(store.root, '.tmp', 'job-new'), { recursive: true });
      const staleTmp = path.join(path.dirname(store.pathFor(live.contentHash!, 'thumb', 256)), '.tmp-abc');
      await writeFile(staleTmp, 'x');
      await utimes(staleTmp, old, old);

      const res = await ctx.app.get(DerivativesGc).run();
      expect(res).toEqual({ dirs: 2, jobs: 3, texts: 2, requeued: 0 });
      expect((await ctx.prisma.itemText.findMany()).map((t) => t.sha).sort()).toEqual([live.contentHash!, trashed, inFlight].sort());
      for (const s of [live.contentHash!, trashed, inFlight]) expect(await store.has(store.pathFor(s, 'thumb', 256))).toBe(true);
      for (const s of [dead, oldFormat]) expect(await store.has(store.pathFor(s, 'thumb', 256))).toBe(false);
      expect((await ctx.prisma.derivativeJob.findMany()).map((j) => j.sha).sort()).toEqual([live.contentHash!, trashed, inFlight].sort());
      expect(await readdir(path.join(store.root, '.tmp'))).toEqual(['job-new']);
      expect(await store.has(staleTmp)).toBe(false);
    });
  });
});
