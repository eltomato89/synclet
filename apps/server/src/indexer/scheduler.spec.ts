import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { trashStagingName } from '../common/names';
import { FilesService } from '../files/files.service';
import { TrashService } from '../trash/trash.service';
import { IndexerService } from './indexer.service';
import { SchedulerService } from './scheduler.service';
import { WatcherService } from './watcher.service';

describe('SchedulerService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('removes leftover temp files at startup and scans all users', async () => {
    const user = await createTestUser(ctx);
    const root = path.join(ctx.config.dataRoot, user.username);
    await writeFile(path.join(root, '.synclet-tmp-dead'), 'partial');
    await writeFile(path.join(root, 'real.txt'), 'x');
    const s = ctx.app.get(SchedulerService);
    expect(await s.startupCleanup()).toBe(1);
    expect(await readdir(root)).toEqual(['real.txt']);
    await s.scanAll();
    expect(await ctx.prisma.item.count()).toBe(1);
    expect(s.lastFullScanAt).toBeInstanceOf(Date);
  });

  it('maintenance purges old tombstones', async () => {
    const user = await createTestUser(ctx);
    await ctx.prisma.item.create({ data: { ownerId: user.id, type: 'file', name: 'x', nameKey: 'x', path: 'x', mtime: new Date(), deletedAt: new Date(Date.now() - 48 * 3600 * 1000) } });
    await ctx.app.get(SchedulerService).maintenance();
    expect(await ctx.prisma.item.count()).toBe(0);
  });

  it('status endpoint is admin-only', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    const token = res.json().accessToken;
    const status = await ctx.app.inject({ method: 'GET', url: '/api/admin/status', headers: { authorization: `Bearer ${token}` } });
    expect(status.json()).toMatchObject({ watch: 'off', users: { total: 1, disabled: 0 } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/status' })).statusCode).toBe(401);
  });

  it('startup cleanup sweeps old temp files and dirs at any depth, sparing trash and symlinked ones', async () => {
    const user = await createTestUser(ctx);
    const root = path.join(ctx.config.dataRoot, user.username);
    const outside = await mkdtemp(path.join(os.tmpdir(), 'synclet-outside-'));
    await writeFile(path.join(outside, '.synclet-tmp-keep'), 'x');
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await mkdir(path.join(root, '.synclet-tmp-dir', 'inner'), { recursive: true });
    await writeFile(path.join(root, '.synclet-tmp-dir', 'inner', 'f'), 'x');
    await writeFile(path.join(root, 'a', 'b', '.synclet-tmp-deep'), 'x');
    await writeFile(path.join(root, 'a', '.synclet-tmp-fresh'), 'x');
    await mkdir(path.join(root, '.synclet-trash-x'));
    await writeFile(path.join(root, '.synclet-trash-x', '.synclet-tmp-intrash'), 'x');
    await symlink(outside, path.join(root, 'a', 'link'));
    await symlink(outside, path.join(root, '.synclet-tmp-link'));
    expect(await ctx.app.get(SchedulerService).startupCleanup()).toBe(3);
    expect((await readdir(root)).sort()).toEqual(['.synclet-tmp-link', '.synclet-trash-x', 'a']);
    expect((await readdir(path.join(root, 'a'))).sort()).toEqual(['b', 'link']);
    expect(await readdir(path.join(root, '.synclet-trash-x'))).toEqual(['.synclet-tmp-intrash']);
    expect(await readdir(outside)).toEqual(['.synclet-tmp-keep']);
    await rm(outside, { recursive: true, force: true });
  });

  it('scanAll refreshes the watcher user map (disabled users are dropped)', async () => {
    const user = await createTestUser(ctx);
    const watcher = ctx.app.get(WatcherService);
    await watcher.refreshUsers();
    const root = path.join(ctx.config.dataRoot, user.username);
    await writeFile(path.join(root, 'a.txt'), 'x');
    await ctx.prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    await ctx.app.get(SchedulerService).scanAll();
    watcher.handleEvents([{ type: 'create', path: path.join(root, 'a.txt') }]);
    await watcher.flush();
    expect(await ctx.prisma.item.count()).toBe(0);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { disabledAt: null } });
    await ctx.app.get(SchedulerService).scanAll();
    watcher.handleEvents([{ type: 'create', path: path.join(root, 'a.txt') }]);
    await watcher.flush();
    expect(await ctx.prisma.item.count()).toBe(1);
  });
  it('scans a new user right away so an existing folder is adopted without waiting for the periodic scan', async () => {
    await mkdir(path.join(ctx.config.dataRoot, 'jens', 'Bestand'), { recursive: true });
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'Bestand', 'alt.txt'), 'alt');
    const s = ctx.app.get(SchedulerService);
    const scanUser = jest.spyOn(s, 'scanUser');
    ctx.config.background = true;
    try {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
      expect(res.statusCode).toBe(201);
      expect(scanUser).toHaveBeenCalledTimes(1);
      await scanUser.mock.results[0].value;
    } finally {
      ctx.config.background = false;
    }
    expect((await ctx.prisma.item.findMany({ orderBy: { path: 'asc' } })).map((i) => i.path)).toEqual(['Bestand', 'Bestand/alt.txt']);
  });

  it('does not scan new users when background jobs are off', async () => {
    const scanUser = jest.spyOn(ctx.app.get(SchedulerService), 'scanUser');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    expect(res.statusCode).toBe(201);
    expect(scanUser).not.toHaveBeenCalled();
  });

  it('bootstrap finishes trash recovery before the first scan (no delete journaled for an uncommitted delete)', async () => {
    const user = await createTestUser(ctx);
    const root = path.join(ctx.config.dataRoot, user.username);
    const files = ctx.app.get(FilesService);
    const a = await files.createFolder(user, null, 'A');
    const x = await files.upload(user, a.id, 'x.txt', Readable.from([Buffer.from('x')]), {});
    // Crash between staging rename and commit: rows live, path vacated, intent on /meta.
    const trashId = '11111111-2222-4333-8444-777777777777';
    await mkdir(path.join(ctx.config.metaRoot, 'staging'), { recursive: true });
    await writeFile(path.join(ctx.config.metaRoot, 'staging', `${trashId}.json`),
      JSON.stringify({ userId: user.id, username: user.username, itemId: x.id, originalRel: 'A/x.txt', name: 'x.txt', type: 'file' }));
    await rename(path.join(root, 'A', 'x.txt'), path.join(root, trashStagingName(trashId)));
    const before = await ctx.prisma.fileChange.count();

    const s = ctx.app.get(SchedulerService);
    const indexer = ctx.app.get(IndexerService);
    let scan: Promise<unknown> = Promise.resolve();
    let restoredWhenScanStarted: boolean | null = null;
    jest.spyOn(s, 'scanAll').mockImplementation(() => {
      restoredWhenScanStarted = existsSync(path.join(root, 'A', 'x.txt'));
      scan = indexer.fullScan(user);
      return scan.then(() => undefined);
    });
    ctx.config.background = true;
    try {
      await s.onApplicationBootstrap();
      expect(restoredWhenScanStarted).toBe(true);
      expect(await scan).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    } finally {
      s.onModuleDestroy();
      ctx.config.background = false;
    }
    expect(await readFile(path.join(root, 'A', 'x.txt'), 'utf8')).toBe('x');
    expect(await ctx.prisma.fileChange.count()).toBe(before);
    expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: x.id } })).deletedAt).toBeNull();
  });
  it('bootstrap starts the watcher only after cleanup and staged-trash recovery, before the first scan', async () => {
    const s = ctx.app.get(SchedulerService);
    const watcher = ctx.app.get(WatcherService);
    const files = ctx.app.get(FilesService);
    const order: string[] = [];
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((r) => { releaseRecovery = r; });
    jest.spyOn(s, 'startupCleanup').mockImplementation(async () => { order.push('cleanup'); return 0; });
    jest.spyOn(files, 'recoverStagedTrash').mockImplementation(async () => { order.push('recover:start'); await recoveryGate; order.push('recover:end'); return 0; });
    const start = jest.spyOn(watcher, 'start').mockImplementation(async () => { order.push('watcher'); });
    jest.spyOn(s, 'scanAll').mockImplementation(async () => { order.push('scan'); });
    ctx.config.background = true;
    try {
      // The watcher's own bootstrap hook must not subscribe (Nest runs hooks concurrently).
      await watcher.onApplicationBootstrap();
      expect(watcher.mode).toBe('off');
      const boot = s.onApplicationBootstrap();
      await new Promise((r) => setImmediate(r));
      expect(order).toEqual(['cleanup', 'recover:start']);
      expect(start).not.toHaveBeenCalled();
      releaseRecovery();
      await boot;
      expect(order).toEqual(['cleanup', 'recover:start', 'recover:end', 'watcher', 'scan']);
    } finally {
      s.onModuleDestroy();
      ctx.config.background = false;
    }
  });
  it('runs maintenance once right after the first scan at boot', async () => {
    const s = ctx.app.get(SchedulerService);
    const order: string[] = [];
    jest.spyOn(s, 'startup').mockResolvedValue();
    jest.spyOn(ctx.app.get(WatcherService), 'start').mockResolvedValue();
    jest.spyOn(s, 'scanAll').mockImplementation(async () => { order.push('scan'); });
    jest.spyOn(s, 'maintenance').mockImplementation(async () => { order.push('maintenance'); });
    ctx.config.background = true;
    try {
      await s.onApplicationBootstrap();
      await s.initialRun;
      expect(order).toEqual(['scan', 'maintenance']);
    } finally {
      s.onModuleDestroy();
      ctx.config.background = false;
    }
  });

  it('maintenance expires old trash entries', async () => {
    const expire = jest.spyOn(ctx.app.get(TrashService), 'expire').mockResolvedValue(0);
    await ctx.app.get(SchedulerService).maintenance();
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('maintenance purges sessions expired or revoked more than 30 days ago', async () => {
    const user = await createTestUser(ctx);
    const day = 24 * 3600 * 1000;
    const mk = (tokenHash: string, expiresAt: Date, revokedAt: Date | null = null) =>
      ctx.prisma.session.create({ data: { userId: user.id, tokenHash, expiresAt, revokedAt } });
    await mk('live', new Date(Date.now() + 10 * day));
    await mk('recently-expired', new Date(Date.now() - 5 * day));
    await mk('recently-revoked', new Date(Date.now() + 10 * day), new Date(Date.now() - 5 * day));
    await mk('old-expired', new Date(Date.now() - 31 * day));
    await mk('old-revoked', new Date(Date.now() - 1 * day), new Date(Date.now() - 31 * day));
    await ctx.app.get(SchedulerService).maintenance();
    const left = (await ctx.prisma.session.findMany()).map((x) => x.tokenHash).sort();
    expect(left).toEqual(['live', 'recently-expired', 'recently-revoked']);
  });
});
