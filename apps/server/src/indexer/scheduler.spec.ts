import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
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
    expect(status.json()).toMatchObject({ watch: 'off', users: 1 });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/status' })).statusCode).toBe(401);
  });

  it('startup cleanup skips directories named like temp files and does not throw', async () => {
    const user = await createTestUser(ctx);
    const root = path.join(ctx.config.dataRoot, user.username);
    await mkdir(path.join(root, '.synclet-tmp-dir'));
    await writeFile(path.join(root, '.synclet-tmp-file'), 'x');
    expect(await ctx.app.get(SchedulerService).startupCleanup()).toBe(1);
    expect(await readdir(root)).toEqual(['.synclet-tmp-dir']);
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
});
