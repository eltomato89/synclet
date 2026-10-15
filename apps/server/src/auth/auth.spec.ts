import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';

describe('auth', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  const setup = (body: object = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery', ...body } });

  it('reports needsSetup until the first admin exists', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: true });
    const res = await setup();
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ username: 'jens', role: 'admin' });
    expect(res.cookies.find((c) => c.name === 'synclet_refresh')).toBeTruthy();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: false });
    expect((await setup({ username: 'other' })).json().code).toBe('setup_done');
  });

  it('creates (or adopts) the user folder', async () => {
    await setup();
    expect((await stat(path.join(ctx.config.dataRoot, 'jens'))).isDirectory()).toBe(true);
  });

  it('rejects unsafe usernames', async () => {
    for (const username of ['../x', '.hidden', 'a/b', 'CON', '']) {
      expect((await setup({ username })).statusCode).toBe(400);
    }
  });

  it('logs in by username or email, refreshes with rotation and detects reuse', async () => {
    await setup({ email: 'jens@example.com' });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'jens', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'JENS@example.com', password: 'correct horse battery' } });
    expect(ok.statusCode).toBe(200);
    const rt1 = ok.cookies.find((c) => c.name === 'synclet_refresh')!.value;

    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${ok.json().accessToken}` } });
    expect(me.json()).toMatchObject({ username: 'jens' });

    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt1 } });
    expect(r2.statusCode).toBe(200);
    const rt2 = r2.cookies.find((c) => c.name === 'synclet_refresh')!.value;
    expect(rt2).not.toBe(rt1);

    // Reusing the rotated token revokes every session of the user.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt1 } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt2 } })).statusCode).toBe(401);
  });

  it('a logged-out token is rejected without ending the other sessions', async () => {
    await setup();
    const login = async () => (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'jens', password: 'correct horse battery' } }))
      .cookies.find((c) => c.name === 'synclet_refresh')!.value;
    const [a, b] = [await login(), await login()];
    await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { synclet_refresh: a } });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: a } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: b } })).statusCode).toBe(200);
  });

  it('rejects missing/invalid bearer tokens with code unauthorized', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer garbage' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });

  it('admin creates users; non-admins cannot', async () => {
    const admin = (await setup()).json().accessToken;
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin}` },
      payload: { username: 'anna', displayName: 'Anna', password: 'another long password' },
    });
    expect(created.statusCode).toBe(201);
    const anna = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' } })).json().accessToken;
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${anna}` } });
    expect(denied.statusCode).toBe(403);
  });

  it('disabled users can no longer authenticate', async () => {
    const admin = (await setup()).json().accessToken;
    const anna = (await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin}` },
      payload: { username: 'anna', displayName: 'Anna', password: 'another long password' },
    })).json();
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' } })).json().accessToken;
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { disabled: true } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });
});
