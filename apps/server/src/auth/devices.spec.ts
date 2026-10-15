import { createTestApp, TestContext } from '../../test/context';
import { DevicesService } from './devices.service';
import { AuthGuard } from './auth.guard';

describe('devices', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  async function adminUser() {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    const u = res.json().user;
    return { id: u.id, username: u.username, role: 'admin' as const, deviceId: null };
  }

  it('issues syd_ tokens once, stores only a hash, and dedupes by installationId', async () => {
    const svc = ctx.app.get(DevicesService);
    const user = await adminUser();
    const a = await svc.register(user, { name: 'Mac', platform: 'macos', appVersion: '1.0', installationId: 'abc' });
    expect(a.token).toMatch(/^syd_[A-Za-z0-9_-]{43}$/);
    const row = await ctx.prisma.syncDevice.findUniqueOrThrow({ where: { id: a.device.id } });
    expect(row.tokenHash).not.toContain(a.token);
    const b = await svc.register(user, { name: 'Mac', platform: 'macos', appVersion: '1.1', installationId: 'abc' });
    const list = await svc.list(user.id);
    expect(list.map((d) => d.id)).toEqual([b.device.id]);
  });

  it('device tokens authenticate; revoked ones get device_revoked', async () => {
    const svc = ctx.app.get(DevicesService);
    const user = await adminUser();
    const { device, token } = await svc.register(user, { name: 'PC', platform: 'windows', appVersion: '1.0' });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    await svc.revoke(user.id, device.id);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('device_revoked');
    expect(ctx.app.get(AuthGuard)).toBeDefined();
  });
});
