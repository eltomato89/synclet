import { createTestApp, TestContext } from '../../test/context';
import { resetAdminPassword } from './reset-admin-password';

describe('reset-admin-password CLI', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  const login = (login: string, password: string) => ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password } });

  it('turns an SSO-only, disabled user into an enabled admin with a local password', async () => {
    const u = await ctx.prisma.user.create({ data: { username: 'Sso', displayName: 'Sso', role: 'user', disabledAt: new Date() } });
    await ctx.prisma.identity.create({ data: { userId: u.id, provider: 'oidc:https://idp', subject: 's' } });
    await ctx.prisma.session.create({ data: { userId: u.id, tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000) } });

    const r = await resetAdminPassword(ctx.prisma, 'sso');
    expect(r).toMatchObject({ username: 'Sso', generated: true });
    expect(r.password.length).toBeGreaterThanOrEqual(20);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({ role: 'admin', disabledAt: null });
    expect(await ctx.prisma.identity.count({ where: { userId: u.id, provider: 'local' } })).toBe(1);
    expect(await ctx.prisma.session.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);
    const res = await login('Sso', r.password);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('admin');
  });

  it('replaces an existing password with the given one; unknown users and short passwords fail', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'root', displayName: 'Root', password: 'old password 123' } });
    expect(await resetAdminPassword(ctx.prisma, 'root', 'brand new password')).toMatchObject({ generated: false, password: 'brand new password' });
    expect((await login('root', 'old password 123')).statusCode).toBe(401);
    expect((await login('root', 'brand new password')).statusCode).toBe(200);
    expect(await ctx.prisma.identity.count({ where: { provider: 'local' } })).toBe(1);
    await expect(resetAdminPassword(ctx.prisma, 'nobody')).rejects.toThrow(/no user/);
    await expect(resetAdminPassword(ctx.prisma, 'root', 'short')).rejects.toThrow(/10/);
  });
});
