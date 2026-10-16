import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { UsersService } from '../auth/users.service';
import { SpacesRepo } from './spaces.repo';

describe('SpacesRepo', () => {
  let ctx: TestContext; let spaces: SpacesRepo;
  beforeEach(async () => { ctx = await createTestApp(); spaces = ctx.app.get(SpacesRepo); });
  afterEach(async () => { await ctx.close(); });

  it('a new user gets its personal space (id = user id) and journal head in the same transaction', async () => {
    const u = await ctx.app.get(UsersService).create({ username: 'anna', displayName: 'Anna', password: 'another long password', role: 'user' });
    const row = await ctx.prisma.space.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({ kind: 'personal', name: 'anna', userId: u.id, rootPath: path.join(ctx.config.dataRoot, 'anna'), readOnly: false, status: 'available' });
    expect(await ctx.prisma.syncScope.findUnique({ where: { spaceId: u.id } })).toMatchObject({ seq: 0n });
    expect(await spaces.personalFor(u.id)).toEqual({ id: u.id, kind: 'personal', rootPath: path.join(ctx.config.dataRoot, 'anna') });
  });

  it('a failed user insert leaves no space behind', async () => {
    await ctx.app.get(UsersService).create({ username: 'anna', displayName: 'Anna', password: 'another long password', role: 'user' });
    await expect(ctx.app.get(UsersService).create({ username: 'ANNA', displayName: 'A', password: 'another long password', role: 'user' }))
      .rejects.toMatchObject({ code: 'name_conflict' });
    expect(await ctx.prisma.space.count()).toBe(1);
  });

  it('syncPersonalRoots fills the root of migrated personal spaces from the config', async () => {
    const u = await createTestUser(ctx, 'bob');
    await ctx.prisma.space.update({ where: { id: u.id }, data: { rootPath: '' } });
    expect(await spaces.syncPersonalRoots()).toBe(1);
    expect((await spaces.byId(u.id))?.rootPath).toBe(path.join(ctx.config.dataRoot, 'bob'));
    expect(await spaces.syncPersonalRoots()).toBe(0);
  });

  it('unknown ids: personalFor is 404, byId is null', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    await expect(spaces.personalFor(id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await spaces.byId(id)).toBeNull();
  });

  it('toIndexSpace fails loudly on an empty root (never cwd-relative disk access)', () => {
    expect(() => spaces.toIndexSpace({ id: 'x', kind: 'personal', rootPath: '' })).toThrow(/no root path/);
    expect(() => spaces.toIndexSpace({ id: 'x', kind: 'team', rootPath: 'relative/dir' })).toThrow(/no root path/);
  });
});
