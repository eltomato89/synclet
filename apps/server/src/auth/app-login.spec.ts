import { createHash } from 'node:crypto';
import { createTestApp, TestContext } from '../../test/context';
import { resolveAppClient } from './app-clients';
import { pkceChallenge } from './app-login.service';

const VERIFIER = 'v'.repeat(50);
const REDIRECT = 'synclet://oauth';
const PW = 'correct horse battery';

describe('app login (PKCE)', () => {
  let ctx: TestContext;
  let admin: string;
  beforeEach(async () => {
    ctx = await createTestApp();
    admin = (await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: PW } })).json().accessToken;
  });
  afterEach(async () => { await ctx.close(); });

  const post = (url: string, payload: object, headers: Record<string, string> = {}) => ctx.app.inject({ method: 'POST', url: `/api/auth/app/${url}`, payload, headers });
  const authorize = (over: object = {}) =>
    post('authorize', { login: 'jens', password: PW, clientId: 'macos', redirectUri: REDIRECT, codeChallenge: pkceChallenge(VERIFIER), codeChallengeMethod: 'S256', ...over });
  const exchange = (code: string, over: object = {}) =>
    post('token', { code, codeVerifier: VERIFIER, clientId: 'macos', redirectUri: REDIRECT, ...over });
  const mkUser = async (username: string) => {
    await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin}` }, payload: { username, displayName: username, password: PW } });
    return (await ctx.prisma.user.findUniqueOrThrow({ where: { username } }));
  };

  it('pkceChallenge matches the RFC 7636 example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(createHash('sha256').update('x').digest('base64url')).toBe(pkceChallenge('x'));
  });

  it('resolves clients and redirect URIs exactly', () => {
    expect(resolveAppClient('ios', REDIRECT)?.id).toBe('ios');
    expect(resolveAppClient('ios', 'synclet://oauth/')).toBeNull();
    expect(resolveAppClient('nope', REDIRECT)).toBeNull();
    expect(resolveAppClient('toString', REDIRECT)).toBeNull();
    for (const id of ['windows', 'linux']) {
      expect(resolveAppClient(id, 'http://127.0.0.1:53682/callback')?.id).toBe(id);
      expect(resolveAppClient(id, 'http://127.0.0.1:1/callback')?.id).toBe(id);
      expect(resolveAppClient(id, 'http://127.0.0.1:65535/callback')?.id).toBe(id);
      expect(resolveAppClient(id, 'http://127.0.0.1:65536/callback')).toBeNull();
      expect(resolveAppClient(id, 'http://127.0.0.1:0/callback')).toBeNull();
      expect(resolveAppClient(id, 'http://localhost:5000/callback')).toBeNull();
      expect(resolveAppClient(id, 'http://127.0.0.1:5000/callback/x')).toBeNull();
      expect(resolveAppClient(id, 'https://127.0.0.1:5000/callback')).toBeNull();
      expect(resolveAppClient(id, REDIRECT)).toBeNull();
    }
    expect(resolveAppClient('macos', 'http://127.0.0.1:5000/callback')).toBeNull();
  });

  it('GET client describes allowed apps and rejects others with 400', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: `/api/auth/app/client?clientId=ios&redirectUri=${encodeURIComponent(REDIRECT)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'ios' });
    const bad = await ctx.app.inject({ method: 'GET', url: '/api/auth/app/client?clientId=ios&redirectUri=evil%3A%2F%2Fx' });
    expect(bad.statusCode).toBe(400);
  });

  it('happy path: authorize, token, access works, device registers, refresh rotates', async () => {
    const a = await authorize();
    expect(a.statusCode).toBe(200);
    const { code } = a.json();
    const row = await ctx.prisma.appAuthCode.findMany();
    expect(JSON.stringify(row)).not.toContain(code); // hash only
    const t = await exchange(code);
    expect(t.statusCode).toBe(200);
    const tok = t.json();
    expect(tok.refreshToken).toMatch(/^syr_/);
    expect(tok.user).toMatchObject({ username: 'jens' });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'jens' } })).lastLoginAt).not.toBeNull();

    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tok.accessToken}` } });
    expect(me.statusCode).toBe(200);
    const dev = await ctx.app.inject({
      method: 'POST', url: '/api/sync/v1/devices', headers: { authorization: `Bearer ${tok.accessToken}` },
      payload: { name: 'My Mac', platform: 'macos', appVersion: '1.0.0' },
    });
    expect(dev.statusCode).toBe(201);

    const r = await post('refresh', { refreshToken: tok.refreshToken });
    expect(r.statusCode).toBe(200);
    expect(r.json().refreshToken).not.toBe(tok.refreshToken);
    expect((await post('refresh', { refreshToken: tok.refreshToken })).statusCode).toBe(401); // reuse
    expect((await post('refresh', { refreshToken: r.json().refreshToken })).statusCode).toBe(401); // family revoked
  });

  it('rejects a wrong verifier, and the code stays usable only with the right one', async () => {
    const { code } = (await authorize()).json();
    expect((await exchange(code, { codeVerifier: 'w'.repeat(50) })).statusCode).toBe(400);
    expect((await exchange(code)).statusCode).toBe(200);
  });

  it('codes are single use', async () => {
    const { code } = (await authorize()).json();
    expect((await exchange(code)).statusCode).toBe(200);
    expect((await exchange(code)).statusCode).toBe(400);
  });

  it('concurrent exchanges yield exactly one token', async () => {
    const { code } = (await authorize()).json();
    const rs = await Promise.all([exchange(code), exchange(code), exchange(code)]);
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('expired codes are refused and purged on the next authorize', async () => {
    const { code } = (await authorize()).json();
    await ctx.prisma.appAuthCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await exchange(code)).statusCode).toBe(400);
    await ctx.prisma.appAuthCode.updateMany({ data: { expiresAt: new Date(Date.now() - 2 * 3_600_000) } });
    await authorize();
    expect(await ctx.prisma.appAuthCode.count()).toBe(1);
  });

  it('binds the code to client and redirect URI', async () => {
    const { code } = (await authorize()).json();
    expect((await exchange(code, { clientId: 'ios' })).statusCode).toBe(400);
    expect((await exchange(code, { redirectUri: 'http://127.0.0.1:5000/callback' })).statusCode).toBe(400);
    expect((await authorize({ clientId: 'windows' })).statusCode).toBe(400); // redirect does not match client
    expect((await authorize({ redirectUri: 'evil://x' })).statusCode).toBe(400);
    expect((await authorize({ codeChallengeMethod: 'plain' })).statusCode).toBe(400);
  });

  it('loopback clients accept any valid port, bound per code', async () => {
    for (const port of [1024, 49152, 65535]) {
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const { code } = (await authorize({ clientId: 'linux', redirectUri })).json();
      expect((await exchange(code, { clientId: 'linux', redirectUri })).statusCode).toBe(200);
    }
    expect((await authorize({ clientId: 'linux', redirectUri: 'http://127.0.0.1:70000/callback' })).statusCode).toBe(400);
  });

  it('wrong password is 401', async () => {
    expect((await authorize({ password: 'nope nope nope' })).statusCode).toBe(401);
  });

  it('a user disabled between authorize and token gets 401', async () => {
    const { code } = (await authorize()).json();
    await ctx.prisma.user.update({ where: { username: 'jens' }, data: { disabledAt: new Date() } });
    expect((await exchange(code)).statusCode).toBe(401);
  });

  it('disabled users cannot authorize', async () => {
    await ctx.prisma.user.update({ where: { username: 'jens' }, data: { disabledAt: new Date() } });
    expect((await authorize()).statusCode).toBe(401);
  });

  it('password login disabled for users: 403 for non-admin, admin ok, emergency restores', async () => {
    await mkUser('anna');
    await ctx.prisma.authSettings.upsert({ where: { id: 1 }, create: { id: 1, passwordLoginForUsers: false }, update: { passwordLoginForUsers: false } });
    const denied = await authorize({ login: 'anna' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('password_login_disabled');
    expect((await authorize()).statusCode).toBe(200);
    await ctx.close();
    ctx = await createTestApp({ ssoEmergency: true });
    await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: PW } });
    await ctx.prisma.authSettings.upsert({ where: { id: 1 }, create: { id: 1, passwordLoginForUsers: false }, update: { passwordLoginForUsers: false } });
    const admin2 = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'jens', password: PW } })).json().accessToken;
    await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin2}` }, payload: { username: 'anna', displayName: 'anna', password: PW } });
    expect((await authorize({ login: 'anna' })).statusCode).toBe(200);
  });

  it('session-based authorize with a web token (SSO) needs auth and validates the client', async () => {
    const body = { clientId: 'macos', redirectUri: REDIRECT, codeChallenge: pkceChallenge(VERIFIER), codeChallengeMethod: 'S256' };
    expect((await post('authorize/session', body)).statusCode).toBe(401);
    expect((await post('authorize/session', { ...body, clientId: 'x' }, { authorization: `Bearer ${admin}` })).statusCode).toBe(400);
    const s = await post('authorize/session', body, { authorization: `Bearer ${admin}` });
    expect(s.statusCode).toBe(200);
    const t = await exchange(s.json().code);
    expect(t.statusCode).toBe(200);
    expect(t.json().user.username).toBe('jens');
  });

  it('session-based authorize ignores the password-login setting (SSO users)', async () => {
    await mkUser('anna');
    const annaToken = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: PW } })).json().accessToken;
    await ctx.prisma.authSettings.upsert({ where: { id: 1 }, create: { id: 1, passwordLoginForUsers: false }, update: { passwordLoginForUsers: false } });
    const s = await post('authorize/session', { clientId: 'ios', redirectUri: REDIRECT, codeChallenge: pkceChallenge(VERIFIER), codeChallengeMethod: 'S256' }, { authorization: `Bearer ${annaToken}` });
    expect(s.statusCode).toBe(200);
  });

  it('rate-limits repeated failed password authorizes', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await authorize({ password: 'bad bad bad' })).statusCode;
    expect(last).toBe(429);
  });
});
