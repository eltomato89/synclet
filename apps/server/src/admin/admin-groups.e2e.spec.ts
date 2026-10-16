import { createTestApp, createTestSpace, TestContext } from '../../test/context';
import { DevicesService } from '../auth/devices.service';
import { ChangeNotifier } from '../events/change-notifier';

describe('admin API: groups', () => {
  let ctx: TestContext;
  let adminToken: string;
  let adminId: string;
  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    adminToken = res.json().accessToken;
    adminId = res.json().user.id;
  });
  afterEach(async () => { await ctx.close(); });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, token = adminToken) =>
    ctx.app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  async function mkUser(username: string, displayName = username) {
    const res = await call('POST', '/admin/users', { username, displayName, password: 'another long password' });
    expect(res.statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: username, password: 'another long password' } });
    return { id: res.json().id as string, token: login.json().accessToken as string };
  }

  it('non-admins get 403, anonymous 401, device tokens 403', async () => {
    const anna = await mkUser('anna');
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: ['GET' | 'POST' | 'PATCH' | 'DELETE', string][] = [
      ['GET', '/admin/groups'], ['POST', '/admin/groups'], ['PATCH', `/admin/groups/${id}`], ['DELETE', `/admin/groups/${id}`],
    ];
    const { token: dtoken } = await ctx.app.get(DevicesService).register({ id: adminId, username: 'jens', role: 'admin', deviceId: null }, { name: 'Mac', platform: 'macos', appVersion: '1' });
    for (const [method, url] of routes) {
      expect((await call(method, url, {}, anna.token)).statusCode).toBe(403);
      expect((await call(method, url, {}, dtoken)).statusCode).toBe(403);
      expect((await ctx.app.inject({ method, url: `/api${url}` })).statusCode).toBe(401);
    }
  });

  it('CRUD: create with members, list, rename, replace members, delete', async () => {
    const anna = await mkUser('anna', 'Anna');
    const bob = await mkUser('bob', 'Bob');
    const created = await call('POST', '/admin/groups', { name: 'Familie', memberIds: [bob.id, anna.id] });
    expect(created.statusCode).toBe(201);
    const g = created.json();
    expect(g).toEqual({ id: expect.any(String), name: 'Familie', members: [
      { id: anna.id, username: 'anna', displayName: 'Anna' }, { id: bob.id, username: 'bob', displayName: 'Bob' },
    ] });
    expect((await call('POST', '/admin/groups', { name: 'Arbeit' })).json()).toMatchObject({ name: 'Arbeit', members: [] });
    // Sorted by name.
    expect((await call('GET', '/admin/groups')).json().map((x: { name: string }) => x.name)).toEqual(['Arbeit', 'Familie']);

    const patched = await call('PATCH', `/admin/groups/${g.id}`, { name: 'Family', memberIds: [bob.id] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ id: g.id, name: 'Family', members: [{ id: bob.id, username: 'bob', displayName: 'Bob' }] });
    // Name only keeps the members.
    expect((await call('PATCH', `/admin/groups/${g.id}`, { name: 'Familie' })).json().members).toHaveLength(1);

    expect((await call('DELETE', `/admin/groups/${g.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/admin/groups')).json().map((x: { name: string }) => x.name)).toEqual(['Arbeit']);
    expect((await call('DELETE', `/admin/groups/${g.id}`)).statusCode).toBe(404);
    expect((await call('PATCH', `/admin/groups/${g.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await call('PATCH', '/admin/groups/not-a-uuid', { name: 'x' })).statusCode).toBe(404);
  });

  it('validates names (unique case-insensitively → 409 name_conflict) and member ids', async () => {
    await call('POST', '/admin/groups', { name: 'Familie' });
    const dup = await call('POST', '/admin/groups', { name: 'FAMILIE' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ statusCode: 409, code: 'name_conflict' });
    const other = (await call('POST', '/admin/groups', { name: 'Arbeit' })).json();
    expect((await call('PATCH', `/admin/groups/${other.id}`, { name: 'familie' })).json().code).toBe('name_conflict');
    // Renaming to itself in another case is fine.
    expect((await call('PATCH', `/admin/groups/${other.id}`, { name: 'ARBEIT' })).statusCode).toBe(200);
    expect((await call('POST', '/admin/groups', { name: '  ' })).statusCode).toBe(400);
    expect((await call('POST', '/admin/groups', {})).statusCode).toBe(400);
    const unknown = await call('POST', '/admin/groups', { name: 'X', memberIds: ['00000000-0000-4000-8000-000000000000'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('invalid_request');
    expect((await call('GET', '/admin/groups')).json()).toHaveLength(2);
  });

  it('the user list shows each user\'s groups', async () => {
    const anna = await mkUser('anna');
    await call('POST', '/admin/groups', { name: 'Zeta', memberIds: [anna.id] });
    const a = (await call('POST', '/admin/groups', { name: 'Alpha', memberIds: [anna.id] })).json();
    const list = (await call('GET', '/admin/users')).json();
    const row = list.find((u: { id: string }) => u.id === anna.id);
    expect(row.groups).toEqual([{ id: a.id, name: 'Alpha' }, { id: expect.any(String), name: 'Zeta' }]);
    expect(list.find((u: { id: string }) => u.id === adminId).groups).toEqual([]);
  });

  it('group changes reach the members of the group\'s spaces as `account` (before ∪ after)', async () => {
    const anna = await mkUser('anna');
    const bob = await mkUser('bob');
    const carl = await mkUser('carl');
    const notifier = ctx.app.get(ChangeNotifier);
    await notifier.ready;
    const got: string[] = [];
    for (const u of [anna, bob, carl]) notifier.subscribeAccount(u.id, () => got.push(u.id));
    const until = async (pred: () => boolean) => { for (let i = 0; i < 60 && !pred(); i++) await new Promise((r) => setTimeout(r, 50)); };

    const g = (await call('POST', '/admin/groups', { name: 'Familie', memberIds: [anna.id] })).json();
    const team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, groupId: g.id, role: 'write' } });

    expect((await call('PATCH', `/admin/groups/${g.id}`, { memberIds: [bob.id] })).statusCode).toBe(200);
    await until(() => got.includes(anna.id) && got.includes(bob.id));
    expect(new Set(got)).toEqual(new Set([anna.id, bob.id]));

    got.length = 0;
    expect((await call('DELETE', `/admin/groups/${g.id}`)).statusCode).toBe(204);
    await until(() => got.includes(bob.id));
    expect(got).toEqual([bob.id]);
    expect(await ctx.prisma.spaceMember.count({ where: { spaceId: team.id } })).toBe(0);
  });
});
