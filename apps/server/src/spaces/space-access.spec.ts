import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { SpaceAccess } from './space-access.service';

describe('SpaceAccess', () => {
  let ctx: TestContext; let access: SpaceAccess;
  beforeEach(async () => { ctx = await createTestApp(); access = ctx.app.get(SpaceAccess); });
  afterEach(async () => { await ctx.close(); });

  const row = (id: string) => ctx.prisma.space.findUniqueOrThrow({ where: { id } });
  const group = async (name: string, userIds: string[]) => ctx.prisma.group.create({
    data: { name, nameKey: name.toLowerCase(), members: { create: userIds.map((userId) => ({ userId })) } },
  });

  it('personal: the owner gets write, another user and an admin get nothing', async () => {
    const anna = await createTestUser(ctx, 'anna');
    const bob = await createTestUser(ctx, 'bob');
    const root = await createTestUser(ctx, 'root');
    await ctx.prisma.user.update({ where: { id: root.id }, data: { role: 'admin' } });
    const space = await row(anna.id);
    expect(await access.roleFor(anna, space)).toBe('write');
    expect(await access.roleFor(bob, space)).toBeNull();
    expect(await access.roleFor(root, space)).toBeNull();
  });

  it('team: the highest of direct and group roles wins; no membership is no access', async () => {
    const anna = await createTestUser(ctx, 'anna');
    const bob = await createTestUser(ctx, 'bob');
    const team = await createTestSpace(ctx, 'Familie');
    const g = await group('Eltern', [anna.id]);
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: anna.id, role: 'read' } });
    expect(await access.roleFor(anna, await row(team.id))).toBe('read');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, groupId: g.id, role: 'write' } });
    expect(await access.roleFor(anna, await row(team.id))).toBe('write');
    expect(await access.roleFor(bob, await row(team.id))).toBeNull();
  });

  it('a read-only space caps the role at read', async () => {
    const anna = await createTestUser(ctx, 'anna');
    const nas = await createTestSpace(ctx, 'NAS', 'external', { readOnly: true });
    await ctx.prisma.spaceMember.create({ data: { spaceId: nas.id, userId: anna.id, role: 'write' } });
    expect(await access.roleFor(anna, await row(nas.id))).toBe('read');
  });

  it('a disabled user has no access, not even to the personal space', async () => {
    const anna = await createTestUser(ctx, 'anna');
    const team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: anna.id, role: 'write' } });
    await ctx.prisma.user.update({ where: { id: anna.id }, data: { disabledAt: new Date() } });
    expect(await access.roleFor(anna, await row(anna.id))).toBeNull();
    expect(await access.roleFor(anna, await row(team.id))).toBeNull();
    expect(await access.spacesFor(anna)).toEqual([]);
  });

  it('spacesFor: personal, then teams by name, then external storages by name', async () => {
    const anna = await createTestUser(ctx, 'anna');
    await createTestUser(ctx, 'bob');
    const nasB = await createTestSpace(ctx, 'B-NAS', 'external');
    const zoo = await createTestSpace(ctx, 'Zoo');
    const nasA = await createTestSpace(ctx, 'A-NAS', 'external', { readOnly: true });
    const alpha = await createTestSpace(ctx, 'Alpha', 'team', { status: 'missing' });
    await createTestSpace(ctx, 'Hidden');
    const g = await group('Alle', [anna.id]);
    for (const s of [nasB, zoo, alpha]) await ctx.prisma.spaceMember.create({ data: { spaceId: s.id, userId: anna.id, role: 'write' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: nasA.id, groupId: g.id, role: 'write' } });
    const list = await access.spacesFor(anna);
    expect(list.map((x) => [x.space.name, x.role])).toEqual([
      ['anna', 'write'], ['Alpha', 'write'], ['Zoo', 'write'], ['A-NAS', 'read'], ['B-NAS', 'write'],
    ]);
  });

  it('require: 404 without access, 403 for a write with read only, 503 when missing', async () => {
    const anna = await createTestUser(ctx, 'anna');
    const bob = await createTestUser(ctx, 'bob');
    const team = await createTestSpace(ctx, 'Familie');
    const gone = await createTestSpace(ctx, 'Weg', 'external', { status: 'missing' });
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: anna.id, role: 'read' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: gone.id, userId: anna.id, role: 'write' } });
    await expect(access.require(bob, team.id, 'read')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(access.require(anna, bob.id, 'read')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(access.require(anna, 'not-a-uuid', 'read')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(access.require(anna, team.id, 'write')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(access.require(anna, gone.id, 'read')).rejects.toMatchObject({ code: 'space_unavailable', status: 503 });
    await expect(access.require(bob, gone.id, 'read')).rejects.toMatchObject({ code: 'not_found' });
    expect(await access.require(anna, team.id, 'read')).toEqual({ space: team, role: 'read' });
    expect(await access.require(anna, anna.id, 'write')).toMatchObject({ space: { id: anna.id, kind: 'personal' }, role: 'write' });
  });

  it('usersOf: the owner of a personal space; direct and group members of a team space', async () => {
    const anna = await createTestUser(ctx, 'anna');
    const bob = await createTestUser(ctx, 'bob');
    const carl = await createTestUser(ctx, 'carl');
    await createTestUser(ctx, 'dora');
    const team = await createTestSpace(ctx, 'Familie');
    const g = await group('Kinder', [bob.id, carl.id]);
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: anna.id, role: 'read' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: bob.id, role: 'read' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, groupId: g.id, role: 'write' } });
    expect(await access.usersOf(anna.id)).toEqual([anna.id]);
    expect((await access.usersOf(team.id)).sort()).toEqual([anna.id, bob.id, carl.id].sort());
    expect(await access.usersOf('00000000-0000-4000-8000-000000000000')).toEqual([]);
  });
});
