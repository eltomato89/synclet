import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { IndexerService } from '../indexer/indexer.service';
import { DiscoveryService } from './discovery.service';
import { SpaceAccess } from './space-access.service';
import { SpacesRepo } from './spaces.repo';

describe('DiscoveryService', () => {
  let ctx: TestContext; let discovery: DiscoveryService;
  beforeEach(async () => { ctx = await createTestApp(); discovery = ctx.app.get(DiscoveryService); });
  afterEach(async () => { jest.restoreAllMocks(); await ctx.close(); });

  const spaces = () => ctx.prisma.space.findMany({ where: { kind: { not: 'personal' } }, orderBy: { name: 'asc' } });
  const team = (name: string) => path.join(ctx.config.teamsRoot, name);
  const storage = (name: string) => path.join(ctx.config.storageRoot, name);

  it('testNewTeamAndStorageDirsBecomeSpaces', async () => {
    await mkdir(team('Familie'));
    await mkdir(storage('NAS'));
    await writeFile(path.join(ctx.config.teamsRoot, 'stray.txt'), 'x');
    const res = await discovery.discover();
    const rows = await spaces();
    expect(rows.map((r) => [r.kind, r.name, r.rootPath, r.status, r.readOnly])).toEqual([
      ['team', 'Familie', team('Familie'), 'available', false],
      ['external', 'NAS', storage('NAS'), 'available', false],
    ]);
    expect(res.created.sort()).toEqual(rows.map((r) => r.id).sort());
    // New spaces have no members, but a journal head.
    expect(await ctx.prisma.spaceMember.count()).toBe(0);
    expect(await ctx.prisma.syncScope.count({ where: { spaceId: { in: rows.map((r) => r.id) } } })).toBe(2);
    // Idempotent.
    expect(await discovery.discover()).toEqual({ created: [], changed: [] });
    expect(await ctx.prisma.space.count()).toBe(2);
  });

  it('a missing teams or storage root means no spaces of that kind', async () => {
    await rm(ctx.config.teamsRoot, { recursive: true, force: true });
    await rm(ctx.config.storageRoot, { recursive: true, force: true });
    expect(await discovery.discover()).toEqual({ created: [], changed: [] });
    expect(await ctx.prisma.space.count()).toBe(0);
  });

  it('testDotAndSymlinkDirsIgnored', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'synclet-outside-'));
    try {
      await mkdir(team('.hidden'));
      await mkdir(team('@eaDir'));
      await mkdir(team('lost+found'));
      await symlink(outside, team('Link'));
      await symlink(outside, storage('LinkNAS'));
      await mkdir(team('Echt'));
      await discovery.discover();
      expect((await spaces()).map((r) => r.name)).toEqual(['Echt']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('testMissingMountKeepsItems', async () => {
    await mkdir(storage('NAS'));
    await writeFile(path.join(storage('NAS'), 'a.txt'), 'a');
    await mkdir(team('Familie'));
    await writeFile(path.join(team('Familie'), 'b.txt'), 'b');
    await discovery.discover();
    const [fam, nas] = await spaces();
    const indexer = ctx.app.get(IndexerService);
    const repo = ctx.app.get(SpacesRepo);
    await indexer.fullScan(repo.toIndexSpace(nas));
    await indexer.fullScan(repo.toIndexSpace(fam));
    expect(await ctx.prisma.item.count({ where: { deletedAt: null } })).toBe(2);

    // The NAS mount is gone (empty mount point), the team folder vanished entirely.
    await rm(path.join(storage('NAS'), 'a.txt'));
    await rm(team('Familie'), { recursive: true });
    const res = await discovery.discover();
    expect(res.changed.sort()).toEqual([fam.id, nas.id].sort());
    expect((await spaces()).map((r) => [r.name, r.status])).toEqual([['Familie', 'missing'], ['NAS', 'missing']]);
    expect(await ctx.prisma.item.count({ where: { deletedAt: null } })).toBe(2);
    // A scan of the empty mount point refuses instead of tombstoning everything.
    expect(await indexer.fullScan(repo.toIndexSpace(nas))).toBeNull();
    expect(await ctx.prisma.item.count({ where: { deletedAt: null } })).toBe(2);
  });

  it('an empty team space root with live items is missing, an empty one without items is not', async () => {
    await mkdir(team('Leer'));
    await mkdir(team('Voll'));
    await writeFile(path.join(team('Voll'), 'x.txt'), 'x');
    await discovery.discover();
    const [, voll] = await spaces();
    await ctx.app.get(IndexerService).fullScan(ctx.app.get(SpacesRepo).toIndexSpace(voll));
    await rm(path.join(team('Voll'), 'x.txt'));
    await discovery.discover();
    expect((await spaces()).map((r) => [r.name, r.status])).toEqual([['Leer', 'available'], ['Voll', 'missing']]);
  });

  it('an empty /teams marks every team space with items as missing', async () => {
    await mkdir(team('Voll'));
    await writeFile(path.join(team('Voll'), 'x.txt'), 'x');
    await discovery.discover();
    const [voll] = await spaces();
    await ctx.app.get(IndexerService).fullScan(ctx.app.get(SpacesRepo).toIndexSpace(voll));
    await rm(team('Voll'), { recursive: true });
    await discovery.discover();
    expect((await spaces()).map((r) => r.status)).toEqual(['missing']);
    expect(await ctx.prisma.item.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('testReturnedMountBecomesAvailable', async () => {
    await mkdir(storage('NAS'));
    await writeFile(path.join(storage('NAS'), 'a.txt'), 'a');
    await discovery.discover();
    const [nas] = await spaces();
    await ctx.app.get(IndexerService).fullScan(ctx.app.get(SpacesRepo).toIndexSpace(nas));
    await rm(storage('NAS'), { recursive: true });
    await discovery.discover();
    expect((await spaces())[0].status).toBe('missing');
    await mkdir(storage('NAS'));
    await writeFile(path.join(storage('NAS'), 'a.txt'), 'a');
    expect(await discovery.discover()).toEqual({ created: [], changed: [nas.id] });
    expect(await spaces()).toMatchObject([{ id: nas.id, status: 'available' }]);
  });

  it('testReadOnlyDetected', async () => {
    if (process.getuid?.() === 0) { console.warn('skipped as root: testReadOnlyDetected'); return; }
    await mkdir(storage('NAS'));
    await chmod(storage('NAS'), 0o555);
    try {
      await discovery.discover();
      expect((await spaces())[0]).toMatchObject({ readOnly: true, status: 'available' });
      await chmod(storage('NAS'), 0o755);
      const res = await discovery.discover();
      expect(res.changed).toHaveLength(1);
      expect((await spaces())[0].readOnly).toBe(false);
    } finally {
      await chmod(storage('NAS'), 0o755);
    }
  });

  it('testCreateRenameRemoveTeam', async () => {
    const created = await discovery.createTeam('Familie');
    expect(created).toMatchObject({ kind: 'team', name: 'Familie', rootPath: team('Familie'), status: 'available' });
    expect((await stat(team('Familie'))).isDirectory()).toBe(true);
    expect(await ctx.prisma.syncScope.findUnique({ where: { spaceId: created.id } })).not.toBeNull();
    await expect(discovery.createTeam('familie')).rejects.toMatchObject({ code: 'name_conflict' });
    await expect(discovery.createTeam('.x')).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(discovery.createTeam('a/b')).rejects.toMatchObject({ code: 'invalid_name' });

    await writeFile(path.join(team('Familie'), 'x.txt'), 'x');
    await ctx.app.get(IndexerService).fullScan(ctx.app.get(SpacesRepo).toIndexSpace(created));
    const user = await createTestUser(ctx, 'anna');
    await ctx.prisma.spaceMember.create({ data: { spaceId: created.id, userId: user.id, role: 'write' } });

    await mkdir(team('Belegt'));
    await expect(discovery.renameTeam(created.id, 'Belegt')).rejects.toMatchObject({ code: 'name_conflict' });
    const renamed = await discovery.renameTeam(created.id, 'Familie Müller');
    expect(renamed).toMatchObject({ id: created.id, name: 'Familie Müller', rootPath: team('Familie Müller') });
    expect((await readdir(ctx.config.teamsRoot)).sort()).toEqual(['Belegt', 'Familie Müller']);
    expect(await readdir(team('Familie Müller'))).toEqual(['x.txt']);
    // Discovery does not see the renamed folder as a new space.
    expect((await discovery.discover()).created).toHaveLength(1); // only "Belegt"

    await discovery.removeSpace(created.id);
    expect(await ctx.prisma.space.findUnique({ where: { id: created.id } })).toMatchObject({ status: 'ignored' });
    expect(await ctx.prisma.item.count({ where: { spaceId: created.id } })).toBe(0);
    expect(await ctx.prisma.spaceMember.count({ where: { spaceId: created.id } })).toBe(0);
    expect(await ctx.prisma.fileChange.count({ where: { scopeId: created.id } })).toBe(0);
    expect(await readdir(team('Familie Müller'))).toEqual(['x.txt']);
  });

  it('a removed (ignored) space is never re-created or re-indexed, and is invisible to former members', async () => {
    await mkdir(storage('NAS'));
    await writeFile(path.join(storage('NAS'), 'a.txt'), 'a');
    await discovery.discover();
    const [nas] = await spaces();
    const user = await createTestUser(ctx, 'anna');
    await ctx.prisma.spaceMember.create({ data: { spaceId: nas.id, userId: user.id, role: 'write' } });
    await ctx.app.get(IndexerService).fullScan(ctx.app.get(SpacesRepo).toIndexSpace(nas));
    const cursorBefore = await ctx.prisma.syncScope.findUniqueOrThrow({ where: { spaceId: nas.id } });

    await discovery.removeSpace(nas.id);
    expect(await discovery.discover()).toEqual({ created: [], changed: [] });
    expect((await spaces()).map((r) => [r.id, r.status])).toEqual([[nas.id, 'ignored']]);
    expect((await ctx.app.get(SpacesRepo).indexable()).map((x) => x.space.id)).not.toContain(nas.id);
    const access = ctx.app.get(SpaceAccess);
    const row = await ctx.prisma.space.findUniqueOrThrow({ where: { id: nas.id } });
    expect(await access.roleFor(user, row)).toBeNull();
    expect(await access.spacesFor(user)).toEqual([expect.objectContaining({ role: 'write', space: expect.objectContaining({ id: user.id }) })]);
    await expect(access.require(user, nas.id, 'read')).rejects.toMatchObject({ code: 'not_found' });
    // Old cursors of the dropped journal expire instead of silently missing deletes.
    const scope = await ctx.prisma.syncScope.findUniqueOrThrow({ where: { spaceId: nas.id } });
    expect(scope.minSeq).toBe(cursorBefore.seq);

    const restored = await discovery.restoreSpace(nas.id);
    expect(restored).toMatchObject({ id: nas.id, status: 'available' });
    expect(await ctx.prisma.spaceMember.count({ where: { spaceId: nas.id } })).toBe(0);
    expect((await ctx.app.get(SpacesRepo).indexable()).map((x) => x.space.id)).toContain(nas.id);
    expect(await ctx.app.get(IndexerService).fullScan(ctx.app.get(SpacesRepo).toIndexSpace(restored))).toMatchObject({ created: 1 });
    await expect(discovery.restoreSpace(user.id)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('a removed team folder can be restored as missing when its folder is gone', async () => {
    const t = await discovery.createTeam('Familie');
    await discovery.removeSpace(t.id);
    await rm(team('Familie'), { recursive: true });
    expect(await discovery.restoreSpace(t.id)).toMatchObject({ status: 'missing' });
  });

  it('createTeam/renameTeam report an unwritable teams folder instead of a 500', async () => {
    if (process.getuid?.() === 0) { console.warn('skipped as root'); return; }
    const t = await discovery.createTeam('Familie');
    await chmod(ctx.config.teamsRoot, 0o555);
    try {
      await expect(discovery.createTeam('Neu')).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/cannot write to .*PUID\/PGID/) });
      await expect(discovery.renameTeam(t.id, 'Anders')).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await chmod(ctx.config.teamsRoot, 0o755);
    }
    expect((await ctx.prisma.space.findUniqueOrThrow({ where: { id: t.id } })).name).toBe('Familie');
  });

  it('renameTeam restores the folder name when the transaction fails after the disk rename', async () => {
    const t = await discovery.createTeam('Familie');
    const orig = ctx.prisma.$transaction.bind(ctx.prisma);
    jest.spyOn(ctx.prisma, '$transaction').mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
      (orig as (f: unknown, o: unknown) => Promise<unknown>)(async (tx: unknown) => { await fn(tx); throw new Error('commit failed'); }, opts)) as never);
    await expect(discovery.renameTeam(t.id, 'Anders')).rejects.toThrow('commit failed');
    expect(await readdir(ctx.config.teamsRoot)).toEqual(['Familie']);
    expect((await ctx.prisma.space.findUniqueOrThrow({ where: { id: t.id } })).name).toBe('Familie');
  });

  it('personal spaces cannot be renamed or removed; external storages cannot be renamed', async () => {
    const user = await createTestUser(ctx, 'anna');
    await mkdir(storage('NAS'));
    await discovery.discover();
    const [nas] = await spaces();
    await expect(discovery.renameTeam(nas.id, 'X')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(discovery.removeSpace(user.id)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(discovery.removeSpace('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  });
});
