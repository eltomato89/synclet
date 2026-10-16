import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { AppEvents } from '../common/events';
import { JournalService } from '../journal/journal.service';
import { IndexerService } from './indexer.service';
import { SchedulerService } from './scheduler.service';
import { WatcherService } from './watcher.service';

describe('WatcherService.handleEvents', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('maps raw events to user directories and indexes them', async () => {
    const user = await createTestUser(ctx);
    const watcher = ctx.app.get(WatcherService);
    await watcher.refresh();
    const root = path.join(ctx.config.dataRoot, user.username);
    await mkdir(path.join(root, 'new'));
    await writeFile(path.join(root, 'new', 'f.txt'), 'x');
    await writeFile(path.join(root, '.synclet-tmp-zz'), 'x');
    watcher.handleEvents([
      { type: 'create', path: path.join(root, 'new') },
      { type: 'create', path: path.join(root, 'new', 'f.txt') },
      { type: 'create', path: path.join(root, '.synclet-tmp-zz') },
      { type: 'create', path: path.join(ctx.config.dataRoot, 'unknown-user', 'x') },
    ]);
    await watcher.flush();
    const paths = (await ctx.prisma.item.findMany({ where: { deletedAt: null } })).map((i) => i.path).sort();
    expect(paths).toEqual(['new', 'new/f.txt']);
  });
  it('ignores trash staging entries and their contents', async () => {
    const user = await createTestUser(ctx);
    const watcher = ctx.app.get(WatcherService);
    await watcher.refresh();
    const root = path.join(ctx.config.dataRoot, user.username);
    const spy = jest.spyOn(ctx.app.get(IndexerService), 'reconcileDir');
    const staged = path.join(root, '.synclet-trash-0123abcd');
    watcher.handleEvents([
      { type: 'create', path: staged },
      { type: 'create', path: path.join(staged, 'inner.txt') },
      { type: 'delete', path: path.join(staged, 'sub', 'deep.txt') },
    ]);
    await watcher.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('indexes a file created under /teams/<name> into the team space and journals it under its space id', async () => {
    const user = await createTestUser(ctx);
    const fam = await createTestSpace(ctx, 'Familie');
    const watcher = ctx.app.get(WatcherService);
    await watcher.refresh();
    await writeFile(path.join(fam.rootPath, 'x.txt'), 'x');
    watcher.handleEvents([
      { type: 'create', path: path.join(fam.rootPath, 'x.txt') },
      { type: 'create', path: path.join(ctx.config.teamsRoot, 'Unbekannt', 'y.txt') },
    ]);
    await watcher.flush();
    const items = await ctx.prisma.item.findMany({ where: { deletedAt: null } });
    expect(items.map((i) => [i.spaceId, i.path])).toEqual([[fam.id, 'x.txt']]);
    const journal = ctx.app.get(JournalService);
    expect((await journal.changesSince(fam.id, '0', 10)).entries.map((e) => e.itemId)).toEqual([items[0].id]);
    expect((await journal.changesSince(user.id, '0', 10)).entries).toEqual([]);
  });

  it('routes events of an external storage to its space; missing spaces are not routed', async () => {
    const nas = await createTestSpace(ctx, 'NAS', 'external');
    const gone = await createTestSpace(ctx, 'Weg', 'external', { status: 'missing' });
    const watcher = ctx.app.get(WatcherService);
    await watcher.refresh();
    await mkdir(path.join(nas.rootPath, 'Fotos'));
    await writeFile(path.join(nas.rootPath, 'Fotos', 'a.jpg'), 'x');
    await writeFile(path.join(gone.rootPath, 'b.jpg'), 'x');
    watcher.handleEvents([
      { type: 'create', path: path.join(nas.rootPath, 'Fotos') },
      { type: 'create', path: path.join(gone.rootPath, 'b.jpg') },
    ]);
    await watcher.flush();
    const items = await ctx.prisma.item.findMany({ where: { deletedAt: null }, orderBy: { path: 'asc' } });
    expect(items.map((i) => [i.spaceId, i.path])).toEqual([[nas.id, 'Fotos'], [nas.id, 'Fotos/a.jpg']]);
  });

  it('keys personal spaces by space id: a renamed space name does not break routing by folder', async () => {
    const user = await createTestUser(ctx, 'anna');
    await ctx.prisma.space.update({ where: { id: user.id }, data: { name: 'something else' } });
    const watcher = ctx.app.get(WatcherService);
    await watcher.refresh();
    const root = path.join(ctx.config.dataRoot, 'anna');
    await writeFile(path.join(root, 'a.txt'), 'x');
    watcher.handleEvents([{ type: 'create', path: path.join(root, 'a.txt') }]);
    await watcher.flush();
    expect((await ctx.prisma.item.findMany()).map((i) => [i.spaceId, i.path])).toEqual([[user.id, 'a.txt']]);
  });

  it('a new user is routable right after user.created (no async lookup)', async () => {
    const watcher = ctx.app.get(WatcherService);
    await watcher.refresh();
    const user = await createTestUser(ctx, 'neu');
    ctx.app.get(AppEvents).emit('user.created', user);
    const root = path.join(ctx.config.dataRoot, 'neu');
    await writeFile(path.join(root, 'a.txt'), 'x');
    watcher.handleEvents([{ type: 'create', path: path.join(root, 'a.txt') }]);
    await watcher.flush();
    expect((await ctx.prisma.item.findMany()).map((i) => [i.spaceId, i.path])).toEqual([[user.id, 'a.txt']]);
  });
});

describe('WatcherService subscriptions', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp({ watch: true }); });
  afterEach(async () => { ctx.config.background = false; await ctx.close(); });

  it('subscribes each external storage separately; watch off is scan-only, a failing subscribe falls back to scan-only', async () => {
    const auto = await createTestSpace(ctx, 'Auto', 'external');
    const off = await createTestSpace(ctx, 'Aus', 'external', { watch: 'off' });
    const broken = await createTestSpace(ctx, 'Kaputt', 'external');
    const watcher = ctx.app.get(WatcherService);
    const parcel = await import('@parcel/watcher');
    const subscribed: string[] = [];
    const subscribe = jest.spyOn(watcher as unknown as { subscribe: (dir: string) => Promise<unknown> }, 'subscribe')
      .mockImplementation(async (dir: string) => {
        subscribed.push(dir);
        if (dir === broken.rootPath) throw new Error('inotify limit');
        return { unsubscribe: async () => {} } as Awaited<ReturnType<typeof parcel.subscribe>>;
      });
    ctx.config.background = true;
    await watcher.refresh();
    await watcher.start();
    await watcher.whenSettled();
    expect(watcher.mode).toBe('active');
    expect(subscribed.sort()).toEqual([ctx.config.dataRoot, ctx.config.teamsRoot, auto.rootPath, broken.rootPath].sort());
    expect(watcher.watchModeOf(auto.id)).toBe('active');
    expect(watcher.watchModeOf(off.id)).toBe('scan-only');
    expect(watcher.watchModeOf(broken.id)).toBe('scan-only');
    // Events below a scan-only external storage are ignored (the periodic scan picks them up).
    await writeFile(path.join(off.rootPath, 'a.txt'), 'x');
    watcher.handleEvents([{ type: 'create', path: path.join(off.rootPath, 'a.txt') }]);
    await watcher.flush();
    expect(await ctx.prisma.item.count()).toBe(0);
    subscribe.mockRestore();
  });

  type Sub = Awaited<ReturnType<typeof import('@parcel/watcher').subscribe>>;
  type Gate = { resolve: (s: Sub) => void; reject: (e: Error) => void };
  /** Subscribe stub: dirs in `hang` wait for their gate, all others succeed at once. */
  function stubSubscribe(watcher: WatcherService, hang: string[]) {
    const gates = new Map<string, Gate>();
    const unsubscribed: string[] = [];
    const sub = (dir: string): Sub => ({ unsubscribe: async () => { unsubscribed.push(dir); } }) as Sub;
    const spy = jest.spyOn(watcher as unknown as { subscribe: (dir: string) => Promise<Sub> }, 'subscribe')
      .mockImplementation((dir: string) => hang.includes(dir)
        ? new Promise<Sub>((resolve, reject) => gates.set(dir, { resolve, reject }))
        : Promise.resolve(sub(dir)));
    return { gates, unsubscribed, sub, spy };
  }
  const blocked = (p: Promise<unknown>) => Promise.race([p.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 500))]);

  it('start does not wait for subscriptions; a hanging storage holds back neither the others nor the data root', async () => {
    const slow = await createTestSpace(ctx, 'SMB', 'external');
    const fast = await createTestSpace(ctx, 'Lokal', 'external');
    const watcher = ctx.app.get(WatcherService);
    const { gates, spy } = stubSubscribe(watcher, [slow.rootPath]);
    ctx.config.background = true;
    await watcher.refresh();
    expect(await blocked(watcher.start())).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(watcher.mode).toBe('active');
    expect(watcher.watchModeOf(fast.id)).toBe('active');
    expect(watcher.watchModeOf(slow.id)).toBe('scan-only');
    // A refresh (every scan cycle) neither waits for nor duplicates the pending subscription.
    expect(await blocked(watcher.refresh())).toBe(false);
    expect(spy.mock.calls.filter(([d]) => d === slow.rootPath)).toHaveLength(1);
    gates.get(slow.rootPath)!.resolve({ unsubscribe: async () => {} } as Sub);
    await watcher.whenSettled();
    expect(watcher.watchModeOf(slow.id)).toBe('active');
  });

  it('application bootstrap and the first scan complete while every subscription hangs', async () => {
    const nas = await createTestSpace(ctx, 'NAS', 'external');
    await writeFile(path.join(nas.rootPath, 'a.txt'), 'x');
    const watcher = ctx.app.get(WatcherService);
    stubSubscribe(watcher, [ctx.config.dataRoot, ctx.config.teamsRoot, nas.rootPath]);
    const scheduler = ctx.app.get(SchedulerService);
    ctx.config.background = true;
    try {
      expect(await blocked(scheduler.onApplicationBootstrap())).toBe(false);
      expect(watcher.mode).toBe('starting');
      await scheduler.initialRun;
      expect((await ctx.prisma.item.findMany({ where: { spaceId: nas.id } })).map((i) => i.path)).toEqual(['a.txt']);
    } finally {
      scheduler.onModuleDestroy();
    }
  });

  it('the data root reports starting, scan-only after the timeout, and active when the subscription completes late', async () => {
    const watcher = ctx.app.get(WatcherService);
    const { gates } = stubSubscribe(watcher, [ctx.config.dataRoot]);
    watcher.subscribeTimeoutMs = 50;
    ctx.config.background = true;
    await watcher.refresh();
    await watcher.start();
    expect(watcher.mode).toBe('starting');
    await new Promise((r) => setTimeout(r, 100));
    expect(watcher.mode).toBe('scan-only');
    gates.get(ctx.config.dataRoot)!.resolve({ unsubscribe: async () => {} } as Sub);
    await watcher.whenSettled();
    expect(watcher.mode).toBe('active');
  });

  it('a rejecting subscribe leaves the data root scan-only', async () => {
    const watcher = ctx.app.get(WatcherService);
    const { gates } = stubSubscribe(watcher, [ctx.config.dataRoot]);
    ctx.config.background = true;
    await watcher.refresh();
    await watcher.start();
    gates.get(ctx.config.dataRoot)!.reject(new Error('inotify limit'));
    await watcher.whenSettled();
    expect(watcher.mode).toBe('scan-only');
  });

  it('a subscription completing after shutdown or after its storage was dropped is unsubscribed', async () => {
    const nas = await createTestSpace(ctx, 'NAS', 'external');
    const watcher = ctx.app.get(WatcherService);
    const { gates, unsubscribed, sub } = stubSubscribe(watcher, [ctx.config.dataRoot, nas.rootPath]);
    ctx.config.background = true;
    await watcher.refresh();
    await watcher.start();
    await ctx.prisma.space.update({ where: { id: nas.id }, data: { watch: 'off' } });
    await watcher.refresh();
    gates.get(nas.rootPath)!.resolve(sub(nas.rootPath));
    await new Promise((r) => setImmediate(r));
    expect(unsubscribed).toEqual([nas.rootPath]);
    expect(watcher.watchModeOf(nas.id)).toBe('scan-only');
    // Shutdown does not wait for the pending data root subscription.
    expect(await blocked(watcher.onModuleDestroy())).toBe(false);
    gates.get(ctx.config.dataRoot)!.resolve(sub(ctx.config.dataRoot));
    await new Promise((r) => setImmediate(r));
    // The active teams root subscription is released by the shutdown, the late data root one when it settles.
    expect(unsubscribed).toEqual([nas.rootPath, ctx.config.teamsRoot, ctx.config.dataRoot]);
    expect(watcher.mode).not.toBe('active');
  });
});
