import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { WatcherService } from './watcher.service';

describe('WatcherService.handleEvents', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('maps raw events to user directories and indexes them', async () => {
    const user = await createTestUser(ctx);
    const watcher = ctx.app.get(WatcherService);
    await watcher.refreshUsers();
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
});
