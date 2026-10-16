import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createTestApp, createTestSpace, createTestUser, personalSpace, TestContext } from '../../test/context';
import { FilesService } from '../files/files.service';
import { IndexerService } from '../indexer/indexer.service';
import { DiscoveryService } from './discovery.service';
import { SpacesRepo } from './spaces.repo';

/**
 * A space resolved before a removeSpace/renameTeam/missing commit must not be acted on afterwards:
 * every mutation re-checks the space row under the space lock (S1).
 */
describe('stale space handles', () => {
  let ctx: TestContext; let files: FilesService; let indexer: IndexerService; let discovery: DiscoveryService;
  beforeEach(async () => {
    ctx = await createTestApp();
    files = ctx.app.get(FilesService); indexer = ctx.app.get(IndexerService); discovery = ctx.app.get(DiscoveryService);
  });
  afterEach(async () => { jest.restoreAllMocks(); await ctx.close(); });

  const body = (s: string) => Readable.from([Buffer.from(s)]);

  it('a scan of a space removed after indexable() re-creates no rows', async () => {
    const t = await createTestSpace(ctx, 'Familie');
    await writeFile(path.join(t.rootPath, 'a.txt'), 'a');
    const [stale] = (await ctx.app.get(SpacesRepo).indexable()).filter((s) => s.space.id === t.id);
    await discovery.removeSpace(t.id);
    expect(await indexer.fullScan(stale.space)).toBeNull();
    await indexer.reconcileDir(stale.space, '', { recursive: true });
    expect(await ctx.prisma.item.count({ where: { spaceId: t.id } })).toBe(0);
    expect(await ctx.prisma.fileChange.count({ where: { scopeId: t.id } })).toBe(0);
  });

  it('a scan with the old root after a rename re-creates no rows there', async () => {
    const t = await createTestSpace(ctx, 'Familie');
    await writeFile(path.join(t.rootPath, 'a.txt'), 'a');
    await discovery.renameTeam(t.id, 'Anders');
    // Someone re-creates a folder with the old name: it is not this space any more.
    await mkdir(t.rootPath);
    await writeFile(path.join(t.rootPath, 'b.txt'), 'b');
    expect(await indexer.fullScan(t)).toBeNull();
    expect(await ctx.prisma.item.count({ where: { spaceId: t.id } })).toBe(0);
  });

  it('an upload resolved before the space was removed is a 404 and leaves no row or file', async () => {
    const t = await createTestSpace(ctx, 'Familie');
    await discovery.removeSpace(t.id);
    await expect(files.upload(t, null, 'a.txt', body('x'), {})).rejects.toMatchObject({ code: 'not_found' });
    await expect(files.createFolder(t, null, 'Neu')).rejects.toMatchObject({ code: 'not_found' });
    expect(await ctx.prisma.item.count({ where: { spaceId: t.id } })).toBe(0);
    expect(await readdir(t.rootPath)).toEqual([]);
  });

  it('writes into a space that went missing or was renamed meanwhile are 503', async () => {
    const t = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.space.update({ where: { id: t.id }, data: { status: 'missing' } });
    await expect(files.createFolder(t, null, 'Neu')).rejects.toMatchObject({ code: 'space_unavailable' });
    await expect(files.upload(t, null, 'a.txt', body('x'), {})).rejects.toMatchObject({ code: 'space_unavailable' });
    expect(await readdir(t.rootPath)).toEqual([]);
    await ctx.prisma.space.update({ where: { id: t.id }, data: { status: 'available' } });
    await discovery.renameTeam(t.id, 'Anders');
    await expect(files.createFolder(t, null, 'Neu')).rejects.toMatchObject({ code: 'space_unavailable' });
    // A folder with the old name exists again: still not this space.
    await mkdir(t.rootPath);
    await expect(files.upload(t, null, 'a.txt', body('x'), {})).rejects.toMatchObject({ code: 'space_unavailable' });
    expect(await readdir(t.rootPath)).toEqual([]);
    expect(await ctx.prisma.item.count({ where: { spaceId: t.id } })).toBe(0);
    expect(await readdir(path.join(ctx.config.teamsRoot, 'Anders'))).toEqual([]);
  });

  it('a move into a space removed meanwhile is a 404 and moves nothing', async () => {
    const user = await createTestUser(ctx, 'anna');
    const mine = personalSpace(ctx, user);
    const t = await createTestSpace(ctx, 'Familie');
    const f = await files.upload(mine, null, 'a.txt', body('x'), {});
    await discovery.removeSpace(t.id);
    await expect(files.update(mine, f.id, { parentId: null, targetSpace: t })).rejects.toMatchObject({ code: 'not_found' });
    expect(await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ spaceId: user.id, deletedAt: null });
    expect(await readdir(mine.rootPath)).toEqual(['a.txt']);
  });
});
