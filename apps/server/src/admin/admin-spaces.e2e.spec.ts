import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createTestApp, createTestSpace, TestContext } from '../../test/context';
import { DevicesService } from '../auth/devices.service';
import { ChangeNotifier } from '../events/change-notifier';

/** Minimal SSE reader: collects event names as they arrive. */
function openStream(port: number, token: string) {
  const events: string[] = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/sync/v1/events', headers: { authorization: `Bearer ${token}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^event: (.+)$/m.exec(block);
        if (m) events.push(m[1]);
      }
    });
  });
  req.on('error', () => undefined);
  return { events, close: () => req.destroy() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

describe('admin API: spaces', () => {
  let ctx: TestContext;
  let adminToken: string;
  let adminId: string;
  beforeEach(async () => {
    // No ping safety net within a test: `account` must come from the signal.
    ctx = await createTestApp({ eventsPingSeconds: 60 });
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
  const accountSpaces = async (token: string) => (await call('GET', '/sync/v1/account', undefined, token)).json().spaces.map((s: { id: string }) => s.id);
  const teamDir = (name: string) => path.join(ctx.config.teamsRoot, name);

  it('non-admins get 403, anonymous 401, device tokens 403', async () => {
    const anna = await mkUser('anna');
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: ['GET' | 'POST' | 'PATCH' | 'DELETE', string][] = [
      ['GET', '/admin/spaces'], ['POST', '/admin/spaces'], ['PATCH', `/admin/spaces/${id}`], ['DELETE', `/admin/spaces/${id}`],
      ['POST', `/admin/spaces/${id}/scan`], ['POST', `/admin/spaces/${id}/restore`],
    ];
    const { token: dtoken } = await ctx.app.get(DevicesService).register({ id: adminId, username: 'jens', role: 'admin', deviceId: null }, { name: 'Mac', platform: 'macos', appVersion: '1' });
    for (const [method, url] of routes) {
      expect((await call(method, url, {}, anna.token)).statusCode).toBe(403);
      expect((await call(method, url, {}, dtoken)).statusCode).toBe(403);
      expect((await ctx.app.inject({ method, url: `/api${url}` })).statusCode).toBe(401);
    }
  });

  it('lists team folders, then external storages, with size, item count and members', async () => {
    const anna = await mkUser('anna', 'Anna');
    const ext = await createTestSpace(ctx, 'NAS', 'external', { readOnly: true, watch: 'off' });
    const team = await createTestSpace(ctx, 'Familie');
    const g = (await call('POST', '/admin/groups', { name: 'Eltern' })).json();
    await ctx.prisma.spaceMember.createMany({ data: [
      { spaceId: team.id, userId: anna.id, role: 'read' }, { spaceId: team.id, groupId: g.id, role: 'write' },
    ] });
    const now = new Date();
    await ctx.prisma.item.createMany({ data: [
      { spaceId: team.id, type: 'folder', name: 'd', nameKey: 'd', path: 'd', size: 0n, mtime: now },
      { spaceId: team.id, type: 'file', name: 'a', nameKey: 'a', path: 'd/a', size: 1500n, mtime: now },
      { spaceId: team.id, type: 'file', name: 'b', nameKey: 'b', path: 'b', size: 99n, mtime: now, deletedAt: now },
    ] });
    const res = await call('GET', '/admin/spaces');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: team.id, kind: 'team', name: 'Familie', rootPath: team.rootPath, status: 'available', readOnly: false, watch: 'auto', scanIntervalSec: null,
        sizeBytes: 1500, itemCount: 2, members: [
          { kind: 'user', id: anna.id, name: 'Anna', role: 'read' }, { kind: 'group', id: g.id, name: 'Eltern', role: 'write' },
        ] },
      { id: ext.id, kind: 'external', name: 'NAS', rootPath: ext.rootPath, status: 'available', readOnly: true, watch: 'off', scanIntervalSec: null,
        sizeBytes: 0, itemCount: 0, members: [] },
    ]);
  });

  describe('POST /admin/spaces', () => {
    it('creates the team folder with its members (201) and tells the members', async () => {
      const anna = await mkUser('anna', 'Anna');
      const g = (await call('POST', '/admin/groups', { name: 'Eltern' })).json();
      const res = await call('POST', '/admin/spaces', { name: 'Familie', members: [{ kind: 'user', id: anna.id, role: 'write' }, { kind: 'group', id: g.id, role: 'read' }] });
      expect(res.statusCode).toBe(201);
      const s = res.json();
      expect(s).toMatchObject({ kind: 'team', name: 'Familie', rootPath: teamDir('Familie'), status: 'available', members: [
        { kind: 'user', id: anna.id, name: 'Anna', role: 'write' }, { kind: 'group', id: g.id, name: 'Eltern', role: 'read' },
      ] });
      expect((await stat(teamDir('Familie'))).isDirectory()).toBe(true);
      expect(await accountSpaces(anna.token)).toEqual(['personal', s.id]);
      // Without members.
      expect((await call('POST', '/admin/spaces', { name: 'Leer' })).json()).toMatchObject({ name: 'Leer', members: [] });
    });

    it('invalid members create nothing (no folder, no row)', async () => {
      for (const members of [
        [{ kind: 'user', id: '00000000-0000-4000-8000-000000000000', role: 'write' }],
        [{ kind: 'group', id: '00000000-0000-4000-8000-000000000000', role: 'read' }],
        [{ kind: 'user', id: adminId, role: 'owner' }],
        [{ kind: 'user', id: adminId, role: 'read' }, { kind: 'user', id: adminId, role: 'write' }],
      ]) {
        const res = await call('POST', '/admin/spaces', { name: 'Familie', members });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('invalid_request');
      }
      expect(await readdir(ctx.config.teamsRoot)).toEqual([]);
      expect(await ctx.prisma.space.count({ where: { kind: 'team' } })).toBe(0);
    });

    it('name rules: invalid → 400 invalid_name, duplicate (case-insensitive) → 409 name_conflict', async () => {
      expect((await call('POST', '/admin/spaces', { name: 'Familie' })).statusCode).toBe(201);
      const dup = await call('POST', '/admin/spaces', { name: 'familie' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ statusCode: 409, code: 'name_conflict' });
      for (const name of ['a/b', 'con', '.hidden', 'trailing.', '']) {
        const res = await call('POST', '/admin/spaces', { name });
        expect(res.statusCode).toBe(400);
      }
      expect(await readdir(ctx.config.teamsRoot)).toEqual(['Familie']);
    });
  });

  describe('PATCH /admin/spaces/:id', () => {
    it('renames a team folder on disk; renaming an external storage → 400', async () => {
      const s = (await call('POST', '/admin/spaces', { name: 'Familie' })).json();
      const res = await call('PATCH', `/admin/spaces/${s.id}`, { name: 'Family' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: s.id, name: 'Family', rootPath: teamDir('Family') });
      expect(await readdir(ctx.config.teamsRoot)).toEqual(['Family']);
      const ext = await createTestSpace(ctx, 'NAS', 'external');
      const bad = await call('PATCH', `/admin/spaces/${ext.id}`, { name: 'Other' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe('invalid_request');
      expect((await call('PATCH', `/admin/spaces/${ext.id}`, { name: 'NAS' })).statusCode).toBe(200); // unchanged name is fine
    });

    it('sets watch and scanIntervalSec; null clears the interval; validates', async () => {
      const ext = await createTestSpace(ctx, 'NAS', 'external');
      expect((await call('PATCH', `/admin/spaces/${ext.id}`, { watch: 'off', scanIntervalSec: 3600 })).json()).toMatchObject({ watch: 'off', scanIntervalSec: 3600 });
      expect((await call('PATCH', `/admin/spaces/${ext.id}`, { scanIntervalSec: null })).json()).toMatchObject({ watch: 'off', scanIntervalSec: null });
      for (const body of [{ watch: 'sometimes' }, { scanIntervalSec: 0 }, { scanIntervalSec: 1.5 }]) {
        expect((await call('PATCH', `/admin/spaces/${ext.id}`, body)).statusCode).toBe(400);
      }
      expect((await call('PATCH', '/admin/spaces/00000000-0000-4000-8000-000000000000', { watch: 'off' })).statusCode).toBe(404);
      const me = (await ctx.prisma.space.findUniqueOrThrow({ where: { id: adminId } })).id;
      expect((await call('PATCH', `/admin/spaces/${me}`, { watch: 'off' })).statusCode).toBe(404);
    });

    it('replaces the member list; invalid members change nothing', async () => {
      const anna = await mkUser('anna', 'Anna');
      const bob = await mkUser('bob', 'Bob');
      const s = (await call('POST', '/admin/spaces', { name: 'Familie', members: [{ kind: 'user', id: anna.id, role: 'write' }] })).json();
      const res = await call('PATCH', `/admin/spaces/${s.id}`, { members: [{ kind: 'user', id: bob.id, role: 'read' }] });
      expect(res.json().members).toEqual([{ kind: 'user', id: bob.id, name: 'Bob', role: 'read' }]);
      expect(await accountSpaces(anna.token)).toEqual(['personal']);
      expect(await accountSpaces(bob.token)).toEqual(['personal', s.id]);
      const bad = await call('PATCH', `/admin/spaces/${s.id}`, { name: 'Neu', members: [{ kind: 'group', id: bob.id, role: 'read' }] });
      expect(bad.statusCode).toBe(400);
      expect((await call('GET', '/admin/spaces')).json()[0]).toMatchObject({ name: 'Familie', members: [{ id: bob.id }] });
    });
  });

  it('testRemovingMemberEmitsAccountEvent', async () => {
    await ctx.app.listen(0, '127.0.0.1');
    const port = (ctx.app.getHttpServer().address() as AddressInfo).port;
    await ctx.app.get(ChangeNotifier).ready;
    const anna = await mkUser('anna');
    const bob = await mkUser('bob');
    const s = (await call('POST', '/admin/spaces', { name: 'Familie', members: [{ kind: 'user', id: anna.id, role: 'write' }, { kind: 'user', id: bob.id, role: 'read' }] })).json();
    const annaStream = openStream(port, anna.token);
    const bobStream = openStream(port, bob.token);
    try {
      await until(() => annaStream.events.includes('hello') && bobStream.events.includes('hello'), 'hello');
      expect((await call('PATCH', `/admin/spaces/${s.id}`, { members: [{ kind: 'user', id: bob.id, role: 'read' }] })).statusCode).toBe(200);
      await until(() => annaStream.events.includes('account'), 'account for the removed member');
      expect(await accountSpaces(anna.token)).toEqual(['personal']);
      // The remaining member is in "before ∪ after" too.
      await until(() => bobStream.events.includes('account'), 'account for the remaining member');
    } finally {
      annaStream.close();
      bobStream.close();
    }
  });

  describe('DELETE and restore', () => {
    it('removing a team folder ignores it (folder stays), tells its former members; restore brings it back', async () => {
      const anna = await mkUser('anna');
      const notifier = ctx.app.get(ChangeNotifier);
      await notifier.ready;
      const got: string[] = [];
      notifier.subscribeAccount(anna.id, () => got.push(anna.id));
      const s = (await call('POST', '/admin/spaces', { name: 'Familie', members: [{ kind: 'user', id: anna.id, role: 'write' }] })).json();
      await writeFile(path.join(teamDir('Familie'), 'keep.txt'), 'x');
      await until(() => got.length > 0, 'account after create');
      got.length = 0;
      expect((await call('DELETE', `/admin/spaces/${s.id}`)).statusCode).toBe(204);
      await until(() => got.length > 0, 'account after delete');
      expect(await readdir(teamDir('Familie'))).toEqual(['keep.txt']);
      expect(await accountSpaces(anna.token)).toEqual(['personal']);
      expect((await call('GET', '/admin/spaces')).json()).toEqual([expect.objectContaining({ id: s.id, status: 'ignored', members: [] })]);
      // An ignored space cannot be changed until restored.
      expect((await call('PATCH', `/admin/spaces/${s.id}`, { watch: 'off' })).statusCode).toBe(400);
      const restored = await call('POST', `/admin/spaces/${s.id}/restore`);
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ id: s.id, status: 'available', members: [] });
    });

    it('external storages can be removed (ignored) too; personal or unknown ids → 404/400', async () => {
      const ext = await createTestSpace(ctx, 'NAS', 'external');
      expect((await call('DELETE', `/admin/spaces/${ext.id}`)).statusCode).toBe(204);
      expect((await ctx.prisma.space.findUniqueOrThrow({ where: { id: ext.id } })).status).toBe('ignored');
      expect((await stat(ext.rootPath)).isDirectory()).toBe(true);
      expect((await call('DELETE', '/admin/spaces/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await call('DELETE', `/admin/spaces/${adminId}`)).statusCode).toBe(404);
      expect((await call('POST', `/admin/spaces/${adminId}/restore`)).statusCode).toBe(404);
    });
  });

  it('POST /:id/scan indexes the space now (202); missing → 503', async () => {
    const anna = await mkUser('anna');
    const s = (await call('POST', '/admin/spaces', { name: 'Familie', members: [{ kind: 'user', id: anna.id, role: 'read' }] })).json();
    await mkdir(path.join(teamDir('Familie'), 'docs'));
    await writeFile(path.join(teamDir('Familie'), 'docs', 'a.txt'), 'hello');
    expect((await call('POST', `/admin/spaces/${s.id}/scan`)).statusCode).toBe(202);
    await until(async () => (await ctx.prisma.item.count({ where: { spaceId: s.id, deletedAt: null } })) === 2, 'scan');
    const missing = await createTestSpace(ctx, 'Weg', 'team', { status: 'missing' });
    const res = await call('POST', `/admin/spaces/${missing.id}/scan`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('space_unavailable');
  });
});
