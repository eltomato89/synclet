import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';
import { hashToken } from '../auth/crypto';
import { DevicesService } from '../auth/devices.service';
import { SharesService } from '../shares/shares.service';
import { dirSize } from './admin-status.service';
import { UpdateCheckService } from './update-check.service';

describe('admin backend', () => {
  let ctx: TestContext;
  let adminToken: string;
  let adminId: string;
  beforeEach(async () => {
    ctx = await createTestApp({ publicUrl: 'https://sync.example.com' });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    adminToken = res.json().accessToken;
    adminId = res.json().user.id;
  });
  afterEach(async () => { await ctx.close(); });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token = adminToken, payload?: object) =>
    ctx.app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  async function mkUser(username: string, extra: object = {}) {
    const res = await call('POST', '/admin/users', adminToken, { username, displayName: username, password: 'another long password', ...extra });
    expect(res.statusCode).toBe(201);
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: username, password: 'another long password' } });
    return { user: res.json(), token: login.json().accessToken as string };
  }

  it('every admin route is 403 for non-admins and 401 anonymous', async () => {
    const { token } = await mkUser('anna');
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: ['GET' | 'POST' | 'PATCH' | 'DELETE', string][] = [
      ['GET', '/admin/users'], ['POST', '/admin/users'], ['PATCH', `/admin/users/${id}`], ['DELETE', `/admin/users/${id}`],
      ['GET', '/admin/folders/unassigned'], ['GET', `/admin/users/${id}/sessions`], ['DELETE', `/admin/users/${id}/sessions/${id}`],
      ['DELETE', `/admin/users/${id}/sessions`], ['GET', `/admin/users/${id}/devices`], ['DELETE', `/admin/users/${id}/devices/${id}`],
      ['GET', '/admin/shares'], ['DELETE', `/admin/shares/${id}`], ['GET', '/admin/status'],
    ];
    for (const [method, url] of routes) {
      expect((await call(method, url, token)).statusCode).toBe(403);
      expect((await ctx.app.inject({ method, url: `/api${url}` })).statusCode).toBe(401);
    }
  });

  it('admin routes refuse device tokens, even those of an admin', async () => {
    const { token: dtoken } = await ctx.app.get(DevicesService).register({ id: adminId, username: 'jens', role: 'admin', deviceId: null }, { name: 'Mac', platform: 'macos', appVersion: '1' });
    const res = await call('GET', '/admin/users', dtoken);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('device tokens cannot use admin routes');
    expect((await call('PUT', '/admin/sso', dtoken, {})).statusCode).toBe(403);
    // The same token still works for the sync API, and the admin's access token for admin routes.
    expect((await call('GET', '/sync/v1/items/root/children', dtoken)).statusCode).toBe(200);
    expect((await call('GET', '/admin/users')).statusCode).toBe(200);
  });

  it('lists users with usage, devices, identities, lastLoginAt', async () => {
    const { user } = await mkUser('anna');
    await ctx.prisma.item.create({ data: { spaceId: user.id, type: 'file', name: 'a', nameKey: 'a', path: 'a', size: 1500n, mtime: new Date() } });
    await ctx.prisma.item.create({ data: { spaceId: user.id, type: 'file', name: 'b', nameKey: 'b', path: 'b', size: 99n, mtime: new Date(), deletedAt: new Date() } });
    await ctx.app.get(DevicesService).register({ id: user.id, username: 'anna', role: 'user', deviceId: null }, { name: 'Mac', platform: 'macos', appVersion: '1' });
    const list = (await call('GET', '/admin/users')).json();
    const anna = list.find((u: { username: string }) => u.username === 'anna');
    expect(anna).toMatchObject({ disabled: false, usedBytes: 1500, devices: 1, role: 'user', identities: [{ provider: 'local', subject: 'anna' }] });
    expect(typeof anna.createdAt).toBe('string');
  });

  describe('last-admin protection', () => {
    it('cannot demote, disable or delete the last admin; self-disable is refused', async () => {
      for (const [m, payload] of [['PATCH', { role: 'user' }], ['PATCH', { disabled: true }], ['DELETE', undefined]] as const) {
        const res = await call(m, `/admin/users/${adminId}`, adminToken, payload);
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: 'conflict' });
      }
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: adminId } }))).toMatchObject({ role: 'admin', disabledAt: null });
    });

    it('with a second admin: demotion is fine, but disabling or deleting yourself stays refused', async () => {
      const { user: second, token: secondToken } = await mkUser('boss', { role: 'admin' });
      const selfDisable = await call('PATCH', `/admin/users/${second.id}`, secondToken, { disabled: true });
      expect(selfDisable.statusCode).toBe(409);
      expect(selfDisable.json().message).toMatch(/yourself/);
      expect((await call('DELETE', `/admin/users/${second.id}`, secondToken)).statusCode).toBe(409);
      expect((await call('PATCH', `/admin/users/${adminId}`, secondToken, { role: 'user' })).statusCode).toBe(200);
      // boss is now the last admin
      const res = await call('PATCH', `/admin/users/${second.id}`, secondToken, { role: 'user' });
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toBe('last admin');
    });

    it('a disabled admin does not count as an admin', async () => {
      const { user: second } = await mkUser('boss', { role: 'admin' });
      expect((await call('PATCH', `/admin/users/${second.id}`, adminToken, { disabled: true })).statusCode).toBe(200);
      expect((await call('PATCH', `/admin/users/${adminId}`, adminToken, { role: 'user' })).statusCode).toBe(409);
    });
  });

  it('patches displayName, email, role, password and rejects duplicate emails', async () => {
    const { user } = await mkUser('anna', { email: 'Anna@x.org' });
    await mkUser('bob', { email: 'bob@x.org' });
    const res = await call('PATCH', `/admin/users/${user.id}`, adminToken, { displayName: 'Anna B', role: 'admin', password: 'brand new password' });
    expect(res.json()).toMatchObject({ displayName: 'Anna B', role: 'admin', email: 'anna@x.org' });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'brand new password' } })).statusCode).toBe(200);
    expect((await call('PATCH', `/admin/users/${user.id}`, adminToken, { email: 'bob@x.org' })).statusCode).toBe(409);
    expect((await call('PATCH', `/admin/users/${user.id}`, adminToken, { email: null })).json().email).toBeNull();
    expect((await call('PATCH', '/admin/users/not-a-uuid', adminToken, {})).statusCode).toBe(404);
  });

  it('delete keeps the folder and revokes sessions, devices and shares', async () => {
    const { user, token } = await mkUser('anna');
    await writeFile(path.join(ctx.config.dataRoot, 'anna', 'keep.txt'), 'x');
    const item = await ctx.prisma.item.create({ data: { spaceId: user.id, type: 'file', name: 'k', nameKey: 'k', path: 'k', mtime: new Date() } });
    const share = await ctx.app.get(SharesService).create({ id: user.id, username: 'anna' }, { itemId: item.id });
    const { device, token: dtoken } = await ctx.app.get(DevicesService).register({ id: user.id, username: 'anna', role: 'user', deviceId: null }, { name: 'Mac', platform: 'macos', appVersion: '1' });
    expect((await call('GET', '/auth/me', token)).statusCode).toBe(200);

    expect((await call('DELETE', `/admin/users/${user.id}`)).statusCode).toBe(204);

    expect((await call('GET', '/auth/me', token)).statusCode).toBe(401);
    expect((await call('GET', '/auth/me', dtoken)).statusCode).toBe(401);
    expect((await ctx.prisma.syncDevice.findUniqueOrThrow({ where: { id: device.id } })).revokedAt).not.toBeNull();
    expect((await ctx.prisma.shareLink.findUniqueOrThrow({ where: { id: share.id } })).revokedAt).not.toBeNull();
    expect(await ctx.prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).disabledAt).not.toBeNull();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(path.join(ctx.config.dataRoot, 'anna'))).toEqual(['keep.txt']);
    expect((await call('DELETE', `/admin/users/${user.id}`)).statusCode).toBe(204); // idempotent
  });

  it('lists unassigned folders and adopts one', async () => {
    const data = ctx.config.dataRoot;
    await mkdir(path.join(data, 'photos'));
    await mkdir(path.join(data, 'Archive'));
    await mkdir(path.join(data, '.hidden'));
    await mkdir(path.join(data, '.synclet-tmp-abc123'));
    await writeFile(path.join(data, 'file.txt'), 'x');
    const outside = await mkdtemp(path.join(os.tmpdir(), 'synclet-outside-'));
    await symlink(outside, path.join(data, 'linked'));
    try {
      expect((await call('GET', '/admin/folders/unassigned')).json()).toEqual([{ name: 'Archive' }, { name: 'photos' }]); // jens is assigned
      const adopt = await call('POST', '/admin/users', adminToken, { username: 'photos', displayName: 'P', password: 'another long password', adoptExistingFolder: true });
      expect(adopt.statusCode).toBe(201);
      expect(adopt.json().username).toBe('photos');
      expect((await call('GET', '/admin/folders/unassigned')).json()).toEqual([{ name: 'Archive' }]);
      const missing = await call('POST', '/admin/users', adminToken, { username: 'ghost', displayName: 'G', password: 'another long password', adoptExistingFolder: true });
      expect(missing.statusCode).toBe(400);
      const linked = await call('POST', '/admin/users', adminToken, { username: 'linked', displayName: 'L', password: 'another long password', adoptExistingFolder: true });
      expect(linked.statusCode).toBe(400);
      const dup = await call('POST', '/admin/users', adminToken, { username: 'photos', displayName: 'P', password: 'another long password', adoptExistingFolder: true });
      expect(dup.statusCode).toBe(409);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('lists and revokes sessions and devices of another user', async () => {
    const { user, token } = await mkUser('anna');
    const other = await mkUser('bob');
    await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' }, headers: { 'user-agent': 'TestAgent/1' } });
    const sessions = (await call('GET', `/admin/users/${user.id}/sessions`)).json();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s: { userAgent: string | null }) => s.userAgent)).toContain('TestAgent/1');
    // a session id of another user cannot be revoked through this user
    const bobSession = (await call('GET', `/admin/users/${other.user.id}/sessions`)).json()[0];
    expect((await call('DELETE', `/admin/users/${user.id}/sessions/${bobSession.id}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/admin/users/${user.id}/sessions/${sessions[0].id}`)).statusCode).toBe(204);
    expect((await call('GET', `/admin/users/${user.id}/sessions`)).json()).toHaveLength(1);
    expect((await call('DELETE', `/admin/users/${user.id}/sessions`)).statusCode).toBe(204);
    expect((await call('GET', `/admin/users/${user.id}/sessions`)).json()).toEqual([]);
    expect((await call('GET', `/admin/users/${other.user.id}/sessions`)).json()).toHaveLength(1);
    expect(token).toBeDefined();

    const { device, token: dtoken } = await ctx.app.get(DevicesService).register({ id: user.id, username: 'anna', role: 'user', deviceId: null }, { name: 'Mac', platform: 'macos', appVersion: '1' });
    const devices = (await call('GET', `/admin/users/${user.id}/devices`)).json();
    expect(devices).toMatchObject([{ id: device.id, userId: user.id, name: 'Mac', platform: 'macos' }]);
    expect((await call('DELETE', `/admin/users/${other.user.id}/devices/${device.id}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/admin/users/${user.id}/devices/${device.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/auth/me', dtoken)).json().code).toBe('device_revoked');
    expect((await call('GET', `/admin/users/${user.id}/devices`)).json()).toEqual([]);
  });

  it('revoking one session does not trigger reuse detection: the user stays signed in elsewhere', async () => {
    const { user } = await mkUser('anna');
    const login = async () => (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' } }))
      .cookies.find((c) => c.name === 'synclet_refresh')!.value;
    const [a, b] = [await login(), await login()];
    const rowA = await ctx.prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(a) } });
    expect((await call('DELETE', `/admin/users/${user.id}/sessions/${rowA.id}`)).statusCode).toBe(204);
    expect(await ctx.prisma.session.findUniqueOrThrow({ where: { id: rowA.id } })).toMatchObject({ revokedReason: 'admin' });
    const refresh = (rt: string) => ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt } });
    expect((await refresh(a)).statusCode).toBe(401);
    // The other browser keeps working (before the fix all sessions were killed as "reuse").
    const rb = await refresh(b);
    expect(rb.statusCode).toBe(200);
    expect((await refresh(rb.cookies.find((c) => c.name === 'synclet_refresh')!.value)).statusCode).toBe(200);
    // A rotated token is still treated as theft.
    expect((await refresh(b)).statusCode).toBe(401);
    expect(await ctx.prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  describe('shares', () => {
    async function mkShare(userId: string, username: string, name: string, expiresAt?: Date) {
      const item = await ctx.prisma.item.create({ data: { spaceId: userId, type: 'file', name, nameKey: name, path: name, mtime: new Date() } });
      const share = await ctx.app.get(SharesService).create({ id: userId, username }, { itemId: item.id });
      if (expiresAt) await ctx.prisma.shareLink.update({ where: { id: share.id }, data: { expiresAt } });
      return share;
    }

    it('lists across users without leaking other users links; revokes any share', async () => {
      const { user } = await mkUser('anna');
      const own = await mkShare(adminId, 'jens', 'mine.txt');
      const theirs = await mkShare(user.id, 'anna', 'hers.txt');
      const expired = await mkShare(user.id, 'anna', 'old.txt', new Date(Date.now() - 1000));

      const active = (await call('GET', '/admin/shares')).json();
      expect(active.map((s: { id: string }) => s.id).sort()).toEqual([own.id, theirs.id].sort());
      const byId = Object.fromEntries(active.map((s: { id: string }) => [s.id, s]));
      expect(byId[own.id].url).toMatch(/^https:\/\/sync\.example\.com\/s\/.+/);
      expect(byId[own.id].owner).toEqual({ id: adminId, username: 'jens' });
      expect(byId[theirs.id]).toMatchObject({ url: '', itemName: 'hers.txt', owner: { id: user.id, username: 'anna' } });
      expect(JSON.stringify(byId[theirs.id])).not.toContain('/s/');

      expect((await call('GET', '/admin/shares?status=expired')).json().map((s: { id: string }) => s.id)).toEqual([expired.id]);
      expect((await call('GET', `/admin/shares?status=all&userId=${user.id}`)).json()).toHaveLength(2);
      expect((await call('GET', '/admin/shares?status=bogus')).statusCode).toBe(400);

      expect((await call('DELETE', `/admin/shares/${theirs.id}`)).statusCode).toBe(204);
      expect((await call('GET', '/admin/shares')).json().map((s: { id: string }) => s.id)).toEqual([own.id]);
      expect((await call('GET', `/admin/shares?status=all&userId=${user.id}`)).json()).toHaveLength(2);
      expect((await call('DELETE', `/admin/shares/${theirs.id}`)).statusCode).toBe(204);
      expect((await call('DELETE', '/admin/shares/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    });
  });

  describe('status', () => {
    it('reports version, disk, meta sizes, job counts and users', async () => {
      const { user } = await mkUser('anna');
      await call('PATCH', `/admin/users/${user.id}`, adminToken, { disabled: true });
      await mkdir(path.join(ctx.config.metaRoot, 'derived', 'ab'), { recursive: true });
      await writeFile(path.join(ctx.config.metaRoot, 'derived', 'ab', 'x'), Buffer.alloc(1234));
      await mkdir(path.join(ctx.config.metaRoot, 'uploads'), { recursive: true });
      await writeFile(path.join(ctx.config.metaRoot, 'uploads', 'u'), Buffer.alloc(10));
      await ctx.prisma.derivativeJob.createMany({ data: [
        { sha: 'a', kind: 'thumb', status: 'pending' }, { sha: 'b', kind: 'thumb', status: 'pending' },
        { sha: 'a', kind: 'text', status: 'failed' }, { sha: 'c', kind: 'text', status: 'done' },
      ] });
      const s = (await call('GET', '/admin/status')).json();
      expect(s.version).toEqual({ installed: 'dev', revision: null, latest: null, latestUrl: null, checkedAt: null, status: 'development' });
      expect(s.users).toEqual({ total: 2, disabled: 1 });
      expect(s.disk.data.totalBytes).toBeGreaterThan(0);
      expect(s.disk.data.freeBytes).toBeGreaterThan(0);
      expect(s.disk.meta.totalBytes).toBeGreaterThan(0);
      expect(s.meta).toEqual({ derivedBytes: 1234, trashBytes: 0, versionsBytes: 0, uploadsBytes: 10 });
      expect(s.jobs.thumb).toEqual({ pending: 2, running: 0, done: 0, failed: 0, unsupported: 0 });
      expect(s.jobs.text).toEqual({ pending: 0, running: 0, done: 1, failed: 1, unsupported: 0 });
      expect(s.office).toEqual({ enabled: false, reachable: null });
      expect(s).toMatchObject({ watch: 'off', lastFullScanAt: null, versions: false });
      expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
    });

    it('reports the installed and the latest release (GitHub mocked)', async () => {
      await ctx.close();
      ctx = await createTestApp({ buildVersion: '0.1.2', buildRevision: 'abcdef0', updateCheck: true, updateRepo: 'me/fork' });
      adminToken = (await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } })).json().accessToken;
      const gh = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(
        JSON.stringify({ tag_name: 'v0.1.10', html_url: 'https://github.com/me/fork/releases/tag/v0.1.10' }), { status: 200 },
      ));
      try {
        // The first request does not wait for GitHub; the check runs in the background.
        expect((await call('GET', '/admin/status')).json().version).toMatchObject({ installed: '0.1.2', status: 'unavailable', checkedAt: null });
        await ctx.app.get(UpdateCheckService).idle();
        const s = (await call('GET', '/admin/status')).json();
        expect(s.version).toMatchObject({
          installed: '0.1.2', revision: 'abcdef0', latest: '0.1.10', latestUrl: 'https://github.com/me/fork/releases/tag/v0.1.10', status: 'update-available',
        });
        expect(Date.parse(s.version.checkedAt)).not.toBeNaN();
        expect(gh).toHaveBeenCalledTimes(1);
        expect(gh.mock.calls[0][0]).toBe('https://api.github.com/repos/me/fork/releases/latest');
        // Cached: further status requests do not ask GitHub again.
        await call('GET', '/admin/status');
        await ctx.app.get(UpdateCheckService).idle();
        expect(gh).toHaveBeenCalledTimes(1);
      } finally {
        gh.mockRestore();
      }
    });

    it('makes no outbound request with the update check off', async () => {
      await ctx.close();
      ctx = await createTestApp({ buildVersion: '0.1.2', updateCheck: false });
      adminToken = (await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } })).json().accessToken;
      const gh = jest.spyOn(global, 'fetch');
      try {
        expect((await call('GET', '/admin/status')).json().version).toMatchObject({ installed: '0.1.2', status: 'disabled', latest: null });
        await ctx.app.get(UpdateCheckService).idle();
        expect(gh).not.toHaveBeenCalled();
      } finally {
        gh.mockRestore();
      }
    });

    it('checks office reachability with a 1 minute cache', async () => {
      await ctx.close();
      ctx = await createTestApp({ officeUrl: 'https://office.example.com', officeInternalUrl: 'http://office.internal' });
      const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
      adminToken = res.json().accessToken;
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('true', { status: 200 }));
      try {
        expect((await call('GET', '/admin/status')).json().office).toEqual({ enabled: true, reachable: true });
        expect((await call('GET', '/admin/status')).json().office.reachable).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('http://office.internal/healthcheck');
      } finally {
        fetchMock.mockRestore();
      }
    });

    it('reports unreachable office when the healthcheck fails', async () => {
      await ctx.close();
      ctx = await createTestApp({ officeUrl: 'https://office.example.com' });
      const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
      adminToken = res.json().accessToken;
      const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      try {
        expect((await call('GET', '/admin/status')).json().office).toEqual({ enabled: true, reachable: false });
      } finally {
        fetchMock.mockRestore();
      }
    });

    it('dirSize does not follow symlinks and tolerates missing dirs', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-size-'));
      const outside = await mkdtemp(path.join(os.tmpdir(), 'synclet-size-out-'));
      try {
        await writeFile(path.join(dir, 'a'), Buffer.alloc(100));
        await mkdir(path.join(dir, 'sub'));
        await writeFile(path.join(dir, 'sub', 'b'), Buffer.alloc(50));
        await writeFile(path.join(outside, 'big'), Buffer.alloc(10_000));
        await symlink(outside, path.join(dir, 'dirlink'));
        await symlink(path.join(outside, 'big'), path.join(dir, 'filelink'));
        expect(await dirSize(dir)).toBe(150);
        expect(await dirSize(path.join(dir, 'missing'))).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});
