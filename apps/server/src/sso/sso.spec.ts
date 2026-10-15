import { stat } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';
import { FakeIdp, startFakeIdp } from '../../test/fake-idp';
import { SecretBox } from '../common/secret-box';
import { AuthService } from '../auth/auth.service';
import { safeReturnPath } from './oidc.service';
import { ProvisioningService, SsoClaims } from './provisioning.service';
import { OIDC_SECRET_PURPOSE, SsoPolicy, SsoSettingsService } from './sso-settings.service';

const PUBLIC_URL = 'https://synclet.test';
const ADMIN_PW = 'correct horse battery';

describe('SSO', () => {
  let ctx: TestContext;
  let idp: FakeIdp;
  let adminToken: string;

  beforeAll(async () => { idp = await startFakeIdp(); });
  afterAll(async () => { await idp.close(); });

  beforeEach(async () => {
    ctx = await createTestApp({ publicUrl: PUBLIC_URL, ssoAllowHttpIssuer: true });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'root', displayName: 'Root', password: ADMIN_PW } });
    adminToken = res.json().accessToken;
    idp.nextClaims = {};
    idp.tamper = {};
    idp.userinfoOnly = {};
  });
  afterEach(async () => { await ctx.close(); });

  const auth = (token = adminToken) => ({ authorization: `Bearer ${token}` });
  const putSso = (payload: object, token = adminToken) => ctx.app.inject({ method: 'PUT', url: '/api/admin/sso', headers: auth(token), payload });
  const enableOidc = async (extra: object = {}) => {
    const res = await putSso({ oidc: { enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, ...extra } });
    expect(res.statusCode).toBe(200);
    return res;
  };
  const createUser = async (username: string, extra: object = {}) => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: auth(), payload: { username, displayName: username, password: 'user password 123', ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  /** Runs start → fake IdP authorize → callback; returns the callback response. */
  async function oidcLogin(claims: Record<string, unknown>, opts: { ret?: string; mutateQuery?: (q: URLSearchParams) => void; dropCookie?: boolean; startCookies?: Record<string, string> } = {}) {
    idp.nextClaims = claims;
    const start = await ctx.app.inject({ method: 'GET', url: `/api/auth/oidc/start?return=${encodeURIComponent(opts.ret ?? '/files/docs')}`, cookies: opts.startCookies ?? {} });
    expect(start.statusCode).toBe(302);
    const flow = start.cookies.find((c) => c.name === 'synclet_oidc');
    expect(flow).toMatchObject({ httpOnly: true, path: '/api/auth/oidc', sameSite: 'Lax' });
    const authorize = new URL(start.headers.location as string);
    expect(authorize.origin).toBe(idp.issuer);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/auth/oidc/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    const back = await fetch(authorize, { redirect: 'manual' });
    expect(back.status).toBe(302);
    const cb = new URL(back.headers.get('location')!);
    opts.mutateQuery?.(cb.searchParams);
    return ctx.app.inject({
      method: 'GET', url: `/api/auth/oidc/callback?${cb.searchParams.toString()}`,
      cookies: opts.dropCookie ? {} : { synclet_oidc: flow!.value },
    });
  }
  const ssoError = (res: { statusCode: number; headers: Record<string, unknown> }) => {
    expect(res.statusCode).toBe(302);
    return new URL(res.headers.location as string, 'http://x').searchParams.get('sso_error');
  };

  describe('safeReturnPath', () => {
    it('rejects everything that is not a same-origin path, also after normalization', () => {
      for (const bad of [
        '/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/%2E%2E//evil.com', '/a/..//evil.com', '/./\\/x', '/\\evil.com',
        '//evil.com', 'https://evil.com', 'javascript:alert(1)', 'evil.com', '', '/a/%2f/evil.com', '/a\u0000b', '/a/../b',
      ]) {
        expect({ bad, out: safeReturnPath(bad) }).toEqual({ bad, out: '/files' });
      }
      for (const good of ['/files', '/files/a%20b', '/app-login?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb#h', '/files/.hidden-not-a-dot-segment']) {
        expect(safeReturnPath(good)).toBe(good);
      }
    });
  });

  describe('settings', () => {
    it('admin-only, defaults, validation', async () => {
      expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/sso' })).statusCode).toBe(401);
      await createUser('bob');
      const bob = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'bob', password: 'user password 123' } })).json();
      expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/sso', headers: auth(bob.accessToken) })).statusCode).toBe(403);
      expect((await putSso({ passwordLoginForUsers: false }, bob.accessToken)).statusCode).toBe(403);

      const get = await ctx.app.inject({ method: 'GET', url: '/api/admin/sso', headers: auth() });
      expect(get.json()).toMatchObject({
        passwordLoginForUsers: true, emergency: false,
        oidc: { enabled: false, hasClientSecret: false, scopes: 'openid profile email', redirectUri: `${PUBLIC_URL}/api/auth/oidc/callback` },
        forwardAuth: { enabled: false, userHeader: 'Remote-User', trustedProxies: [] },
      });

      const invalid: object[] = [
        { oidc: { issuer: 'ftp://idp.example.com' } },
        { oidc: { issuer: 'not a url' } },
        { oidc: { issuer: 'http://8.8.8.8/realm' } }, // http only for private hosts
        { oidc: { issuer: 'https://user:pw@idp.example.com' } },
        { oidc: { scopes: 'profile email' } },
        { oidc: { enabled: true, issuer: idp.issuer } }, // no client id
        { oidc: { clientSecretx: 'x' } },
        { forwardAuth: { userHeader: 'Remote User' } },
        { forwardAuth: { trustedProxies: ['10.0.0.0/33'] } },
        { forwardAuth: { trustedProxies: ['0.0.0.0/0'] } },
        { forwardAuth: { trustedProxies: ['banana'] } },
        { forwardAuth: { enabled: true } }, // no trusted proxies
        { unknown: true },
      ];
      for (const payload of invalid) {
        const res = await putSso(payload);
        expect({ payload, status: res.statusCode, code: res.json().code }).toEqual({ payload, status: 400, code: 'invalid_request' });
      }
      const ok = await putSso({ forwardAuth: { enabled: true, trustedProxies: ['10.0.0.0/8', '::1', 'fd00::/8'], userHeader: 'X-Auth-User' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().forwardAuth).toMatchObject({ enabled: true, trustedProxies: ['10.0.0.0/8', '::1', 'fd00::/8'], userHeader: 'X-Auth-User' });
    });

    it('rejects http issuers unless explicitly allowed', async () => {
      await ctx.close();
      ctx = await createTestApp({ publicUrl: PUBLIC_URL });
      adminToken = (await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'root', displayName: 'Root', password: ADMIN_PW } })).json().accessToken;
      const res = await putSso({ oidc: { enabled: true, issuer: idp.issuer, clientId: 'synclet' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/https/);
    });

    it('refuses to enable OIDC without SYNCLET_PUBLIC_URL', async () => {
      await ctx.close();
      ctx = await createTestApp({ ssoAllowHttpIssuer: true });
      adminToken = (await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'root', displayName: 'Root', password: ADMIN_PW } })).json().accessToken;
      const res = await putSso({ oidc: { enabled: true, issuer: idp.issuer, clientId: 'synclet' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/SYNCLET_PUBLIC_URL/);
    });

    it('never returns the client secret and stores it encrypted', async () => {
      const res = await enableOidc();
      expect(res.json().oidc.hasClientSecret).toBe(true);
      expect(res.body).not.toContain(idp.clientSecret);
      expect(res.body).not.toContain('clientSecret"');
      const get = await ctx.app.inject({ method: 'GET', url: '/api/admin/sso', headers: auth() });
      expect(get.body).not.toContain(idp.clientSecret);
      expect(get.json().oidc).not.toHaveProperty('clientSecret');

      const row = await ctx.prisma.authSettings.findUniqueOrThrow({ where: { id: 1 } });
      expect(row.oidcClientSecretEnc).toBeTruthy();
      expect(row.oidcClientSecretEnc).not.toContain(idp.clientSecret);
      const { jwtSecret } = await ctx.prisma.serverConfig.findUniqueOrThrow({ where: { id: 1 } });
      expect(new SecretBox(jwtSecret).open(row.oidcClientSecretEnc!, OIDC_SECRET_PURPOSE)).toBe(idp.clientSecret);

      // Omitted keeps it, null clears it.
      expect((await putSso({ oidc: { buttonLabel: 'Login with IdP' } })).json().oidc.hasClientSecret).toBe(true);
      expect((await putSso({ oidc: { clientSecret: null } })).json().oidc.hasClientSecret).toBe(false);
      expect((await ctx.prisma.authSettings.findUniqueOrThrow({ where: { id: 1 } })).oidcClientSecretEnc).toBeNull();
    });

    it('a failing discovery blocks enabling; the test endpoint reports it', async () => {
      const dead = 'http://127.0.0.1:9'; // discard port: connection refused
      const res = await putSso({ oidc: { enabled: true, issuer: dead, clientId: 'synclet' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'invalid_request' });
      expect(res.json().message).toMatch(/discovery failed/);
      expect((await ctx.prisma.authSettings.findUnique({ where: { id: 1 } }))?.oidcEnabled ?? false).toBe(false);

      const bad = await ctx.app.inject({ method: 'POST', url: '/api/admin/sso/test', headers: auth(), payload: { issuer: dead } });
      expect(bad.json()).toMatchObject({ ok: false });
      expect(bad.json().error).toBeTruthy();
      const good = await ctx.app.inject({ method: 'POST', url: '/api/admin/sso/test', headers: auth(), payload: { issuer: idp.issuer } });
      expect(good.json()).toEqual({ ok: true, issuer: idp.issuer });
      // Nothing saved by the test.
      expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/sso', headers: auth() })).json().oidc.issuer).toBeNull();
    });

    it('login methods reflect the settings', async () => {
      const m0 = (await ctx.app.inject({ method: 'GET', url: '/api/auth/methods' })).json();
      expect(m0).toEqual({ password: true, oidc: { enabled: false, label: 'Single Sign-on' }, forwardAuth: false, emergency: false });
      await enableOidc({ buttonLabel: 'Firmen-Login' });
      await putSso({ passwordLoginForUsers: false, forwardAuth: { enabled: true, trustedProxies: ['10.0.0.0/8'] } });
      const m1 = (await ctx.app.inject({ method: 'GET', url: '/api/auth/methods' })).json();
      expect(m1).toEqual({ password: false, oidc: { enabled: true, label: 'Firmen-Login' }, forwardAuth: true, emergency: false });
    });
  });

  describe('OIDC login', () => {
    it('provisions a new user with folder, sets the refresh cookie and redirects to the return path', async () => {
      await enableOidc();
      const res = await oidcLogin({ sub: 'u-1', preferred_username: 'jkoehler', name: 'Jens Köhler', email: 'Jens@Example.com', email_verified: true });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/files/docs');
      const refresh = res.cookies.find((c) => c.name === 'synclet_refresh');
      expect(refresh).toBeTruthy();
      expect(res.cookies.find((c) => c.name === 'synclet_oidc')?.value).toBe(''); // flow cookie cleared

      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'jkoehler' }, include: { identities: true } });
      expect(user).toMatchObject({ displayName: 'Jens Köhler', email: 'jens@example.com', role: 'user' });
      expect(user.lastLoginAt).toBeInstanceOf(Date);
      expect(user.identities).toEqual([expect.objectContaining({ provider: `oidc:${idp.issuer}`, subject: 'u-1', passwordHash: null })]);
      expect((await stat(path.join(ctx.config.dataRoot, 'jkoehler'))).isDirectory()).toBe(true);

      const r = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: refresh!.value } });
      expect(r.statusCode).toBe(200);
      expect(r.json().user).toMatchObject({ username: 'jkoehler' });

      // Returning user is found by subject (claims changed, still the same account).
      const again = await oidcLogin({ sub: 'u-1', preferred_username: 'renamed', email: 'other@example.com', email_verified: true });
      expect(again.statusCode).toBe(302);
      expect(again.headers.location).toBe('/files/docs');
      expect(await ctx.prisma.user.count()).toBe(2);
    });

    it('only redirects to same-origin relative paths', async () => {
      await enableOidc();
      for (const ret of ['//evil.example', 'https://evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/.//evil.example']) {
        const res = await oidcLogin({ sub: `s-${ret}`, preferred_username: 'x' }, { ret });
        expect(res.headers.location).toBe('/files');
      }
      expect((await oidcLogin({ sub: 's-ok', preferred_username: 'x' }, { ret: '/app-login?client_id=a&state=b' })).headers.location)
        .toBe('/app-login?client_id=a&state=b');
    });

    it('ends the previous session of the browser after a successful login (its cookie travels in the flow cookie)', async () => {
      await enableOidc();
      const refreshOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'synclet_refresh')!.value;
      const first = refreshOf(await oidcLogin({ sub: 'p-1', preferred_username: 'paula' }));
      const second = refreshOf(await oidcLogin({ sub: 'p-1', preferred_username: 'paula' }, { startCookies: { synclet_refresh: first } }));
      expect(await ctx.prisma.session.findFirst({ where: { revokedAt: { not: null }, revokedReason: 'logout' } })).toBeTruthy();
      const refresh = (rt: string) => ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt } });
      expect((await refresh(first)).statusCode).toBe(401);
      expect((await refresh(second)).statusCode).toBe(200);
    });

    it('a failed attempt returns to the login page with the safe return path as next', async () => {
      const failStart = await ctx.app.inject({ method: 'GET', url: `/api/auth/oidc/start?return=${encodeURIComponent('/app-login?client_id=a&state=b')}` });
      const loc = new URL(failStart.headers.location as string, 'http://x');
      expect([loc.pathname, loc.searchParams.get('sso_error'), loc.searchParams.get('next')]).toEqual(['/login', 'oidc_disabled', '/app-login?client_id=a&state=b']);
      await enableOidc();
      const failCb = await oidcLogin({ sub: 'n-1' }, { ret: '/app-login?client_id=a&state=b', mutateQuery: (q) => q.set('state', 'forged') });
      expect(new URL(failCb.headers.location as string, 'http://x').searchParams.get('next')).toBe('/app-login?client_id=a&state=b');
      // Unsafe or default targets are not carried along; neither is anything without a valid flow cookie.
      for (const ret of ['//evil.example', '/files']) {
        const res = await oidcLogin({ sub: 'n-2' }, { ret, mutateQuery: (q) => q.set('state', 'forged') });
        expect(res.headers.location).toBe('/login?sso_error=invalid_state');
      }
      expect((await oidcLogin({ sub: 'n-3' }, { dropCookie: true })).headers.location).toBe('/login?sso_error=invalid_state');
    });

    it('rejects a state mismatch or a missing flow cookie', async () => {
      await enableOidc();
      expect(ssoError(await oidcLogin({ sub: 'u-2' }, { mutateQuery: (q) => q.set('state', 'forged') }))).toBe('invalid_state');
      expect(ssoError(await oidcLogin({ sub: 'u-2' }, { dropCookie: true }))).toBe('invalid_state');
      expect(ssoError(await ctx.app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=x&state=y', cookies: { synclet_oidc: 'garbage' } }))).toBe('invalid_state');
      expect(await ctx.prisma.user.count()).toBe(1);
    });

    it('rejects a nonce mismatch, a wrong issuer and a wrong audience', async () => {
      await enableOidc();
      idp.tamper = { nonce: 'other-nonce' };
      expect(ssoError(await oidcLogin({ sub: 'u-3', preferred_username: 'mallory' }))).toBe('oidc_failed');
      idp.tamper = { iss: 'https://evil.example' };
      expect(ssoError(await oidcLogin({ sub: 'u-3', preferred_username: 'mallory' }))).toBe('oidc_failed');
      idp.tamper = { aud: 'someone-else' };
      expect(ssoError(await oidcLogin({ sub: 'u-3', preferred_username: 'mallory' }))).toBe('oidc_failed');
      expect(await ctx.prisma.user.count()).toBe(1);
    });

    it('reports IdP errors and a disabled OIDC', async () => {
      expect(ssoError(await ctx.app.inject({ method: 'GET', url: '/api/auth/oidc/start' }))).toBe('oidc_disabled');
      await enableOidc();
      expect(ssoError(await oidcLogin({ sub: 'u-4' }, { mutateQuery: (q) => { q.delete('code'); q.set('error', 'access_denied'); } }))).toBe('idp_error');
    });

    it('uses groups from userinfo: allowed-groups gate and admin group', async () => {
      await enableOidc({ allowedGroups: ['synclet'], adminGroups: ['synclet-admins'] });
      expect(ssoError(await oidcLogin({ sub: 'g-1', preferred_username: 'outsider' }))).toBe('sso_not_allowed');
      expect(await ctx.prisma.user.count()).toBe(1);

      idp.userinfoOnly = { groups: ['synclet', 'synclet-admins'] };
      expect((await oidcLogin({ sub: 'g-2', preferred_username: 'boss' })).headers.location).toBe('/files/docs');
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'boss' } })).role).toBe('admin');
    });

    it('disabled users cannot log in', async () => {
      await enableOidc();
      await oidcLogin({ sub: 'd-1', preferred_username: 'dora' });
      await ctx.prisma.user.update({ where: { username: 'dora' }, data: { disabledAt: new Date() } });
      expect(ssoError(await oidcLogin({ sub: 'd-1', preferred_username: 'dora' }))).toBe('unauthorized');
    });

    it('re-discovers after a settings change', async () => {
      await enableOidc();
      await oidcLogin({ sub: 'r-1', preferred_username: 'rita' });
      const before = idp.discoveries;
      await oidcLogin({ sub: 'r-1', preferred_username: 'rita' });
      expect(idp.discoveries).toBe(before); // cached
      await putSso({ oidc: { buttonLabel: 'New label' } });
      await oidcLogin({ sub: 'r-1', preferred_username: 'rita' });
      expect(idp.discoveries).toBeGreaterThan(before);
    });
  });

  describe('provisioning', () => {
    const policy: SsoPolicy = { allowedGroups: [], adminGroups: [], linkByEmail: false };
    const claims = (over: Partial<SsoClaims>): SsoClaims => ({
      provider: 'oidc:https://idp', subject: 's', email: null, emailVerified: false, preferredUsername: null, name: null, groups: [], ...over,
    });
    const prov = () => ctx.app.get(ProvisioningService);

    it('sanitizes usernames from claims and suffixes collisions', async () => {
      const cases: [string, string][] = [
        ['../evil', 'evil'], ['CON', 'user'], ['.hidden', 'hidden'], ['Jens Köhler', 'Jens-Köhler'], ['a/b\\c', 'a-b-c'],
        ['x'.repeat(100), 'x'.repeat(64)], ['\u202Emallory', 'mallory'], ['bob@example.com', 'bob-example.com'], ['...', 'user-2'],
      ];
      for (const [i, [raw, expected]] of cases.entries()) {
        const u = await prov().resolve(claims({ subject: `s${i}`, preferredUsername: raw }), policy);
        expect({ raw, username: u.username }).toEqual({ raw, username: expected });
        expect((await stat(path.join(ctx.config.dataRoot, u.username))).isDirectory()).toBe(true);
      }
      // 'root' exists (setup admin), case-insensitively; 'user'/'user-2' already taken above.
      expect((await prov().resolve(claims({ subject: 'c1', preferredUsername: 'ROOT' }), policy)).username).toBe('ROOT-2');
      expect((await prov().resolve(claims({ subject: 'c2', preferredUsername: 'root' }), policy)).username).toBe('root-3');
      expect((await prov().resolve(claims({ subject: 'c3', preferredUsername: 'Con' }), policy)).username).toBe('user-3');
      // A suffixed 64-char name stays within the limit.
      expect((await prov().resolve(claims({ subject: 'c4', preferredUsername: 'x'.repeat(100) }), policy)).username).toBe(`${'x'.repeat(62)}-2`);
    });

    it('never adopts an existing unassigned folder', async () => {
      await mkdir(path.join(ctx.config.dataRoot, 'orphan'));
      expect((await prov().resolve(claims({ subject: 'o', preferredUsername: 'Orphan' }), policy)).username).toBe('Orphan-2');
    });

    it('allowed-groups gate and admin group', async () => {
      const gated = { ...policy, allowedGroups: ['staff'], adminGroups: ['admins'] };
      await expect(prov().resolve(claims({ subject: 'g', preferredUsername: 'gina', groups: ['other'] }), gated)).rejects.toMatchObject({ code: 'sso_not_allowed' });
      expect(await ctx.prisma.user.count({ where: { username: 'gina' } })).toBe(0);
      expect((await prov().resolve(claims({ subject: 'g', preferredUsername: 'gina', groups: ['staff'] }), gated)).role).toBe('user');
      expect((await prov().resolve(claims({ subject: 'h', preferredUsername: 'hank', groups: ['staff', 'admins'] }), gated)).role).toBe('admin');
      // Removed from the allowed group later: no access any more.
      await expect(prov().resolve(claims({ subject: 'g', groups: [] }), gated)).rejects.toMatchObject({ code: 'sso_not_allowed' });
    });

    it('links by email only when verified and enabled', async () => {
      const bob = await createUser('bob', { email: 'bob@example.com' });
      const verified = claims({ subject: 'b1', preferredUsername: 'bob', email: 'BOB@example.com', emailVerified: true });

      // Linking disabled: a new account (suffixed), the taken email is not copied.
      const a = await prov().resolve(verified, policy);
      expect(a.id).not.toBe(bob.id);
      expect(a).toMatchObject({ username: 'bob-2', email: null });

      // Linking enabled but unverified email: new account.
      const b = await prov().resolve(claims({ subject: 'b2', preferredUsername: 'bob', email: 'bob@example.com', emailVerified: false }), { ...policy, linkByEmail: true });
      expect(b.id).not.toBe(bob.id);
      expect(b.username).toBe('bob-3');

      // Enabled and verified: attaches to bob; next login by subject.
      const c = await prov().resolve({ ...verified, subject: 'b3' }, { ...policy, linkByEmail: true });
      expect(c.id).toBe(bob.id);
      expect(await ctx.prisma.identity.count({ where: { userId: bob.id } })).toBe(2);
      expect((await prov().resolve(claims({ subject: 'b3' }), policy)).id).toBe(bob.id);
    });

    it('does not store unverified emails on new users', async () => {
      const u = await prov().resolve(claims({ subject: 'e1', preferredUsername: 'eve', email: 'victim@example.com', emailVerified: false }), policy);
      expect(u.email).toBeNull();
    });

    it('rejects disabled users', async () => {
      const u = await prov().resolve(claims({ subject: 'x1', preferredUsername: 'xena' }), policy);
      await ctx.prisma.user.update({ where: { id: u.id }, data: { disabledAt: new Date() } });
      await expect(prov().resolve(claims({ subject: 'x1' }), policy)).rejects.toMatchObject({ code: 'unauthorized' });
    });

    it('SSO-only admins do not count as the last password admin', async () => {
      const admins = { ...policy, adminGroups: ['admins'] };
      const root = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'root' } });
      await ctx.prisma.identity.create({ data: { userId: root.id, provider: 'oidc:https://idp', subject: 'root-sub' } });
      const sso = await prov().resolve(claims({ subject: 'sso-admin', preferredUsername: 'ssoadmin', groups: ['admins'] }), admins);
      expect(sso.role).toBe('admin');
      // root is the only admin with a password: not demoted by SSO although another (SSO-only) admin exists.
      expect((await prov().resolve(claims({ subject: 'root-sub', groups: [] }), admins)).role).toBe('admin');
      // Nor through the admin API by the SSO-only admin.
      const ssoToken = (await ctx.app.get(AuthService).issue(sso)).access.accessToken;
      for (const req of [
        { method: 'PATCH' as const, url: `/api/admin/users/${root.id}`, payload: { role: 'user' } },
        { method: 'PATCH' as const, url: `/api/admin/users/${root.id}`, payload: { disabled: true } },
        { method: 'DELETE' as const, url: `/api/admin/users/${root.id}` },
      ]) {
        const res = await ctx.app.inject({ ...req, headers: auth(ssoToken) });
        expect({ req, status: res.statusCode }).toEqual({ req, status: 409 });
      }
      expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: root.id } })).toMatchObject({ role: 'admin', disabledAt: null });
      // The SSO-only admin itself can be demoted (root keeps a password).
      expect((await prov().resolve(claims({ subject: 'sso-admin', groups: [] }), admins)).role).toBe('user');
    });

    it('concurrent admin-API and SSO demotions never leave zero password admins', async () => {
      const admins = { ...policy, adminGroups: ['admins'] };
      const root = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'root' } });
      await ctx.prisma.identity.create({ data: { userId: root.id, provider: 'oidc:https://idp', subject: 'root-sub' } });
      const anna = await createUser('anna', { role: 'admin' });
      for (let round = 0; round < 8; round++) {
        await ctx.prisma.user.updateMany({ where: { id: { in: [root.id, anna.id] } }, data: { role: 'admin' } });
        // root demotes anna via the API while root's own SSO login (no admin group) demotes root.
        const [patch] = await Promise.all([
          ctx.app.inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, headers: auth(), payload: { role: 'user' } }),
          prov().resolve(claims({ subject: 'root-sub', groups: [] }), admins),
        ]);
        expect([200, 403, 409]).toContain(patch.statusCode); // 403: root was demoted first
        const left = await ctx.prisma.user.count({ where: { role: 'admin', disabledAt: null } });
        expect(left).toBe(1);
      }
    });

    it('syncs the role from groups but never demotes the last admin', async () => {
      const admins = { ...policy, adminGroups: ['admins'] };
      const u = await prov().resolve(claims({ subject: 'a1', preferredUsername: 'anna', groups: ['admins'] }), admins);
      expect(u.role).toBe('admin');
      // Make anna the only active admin.
      await ctx.prisma.user.update({ where: { username: 'root' }, data: { role: 'user' } });
      const kept = await prov().resolve(claims({ subject: 'a1', groups: [] }), admins);
      expect(kept.role).toBe('admin');
      // With another admin present the demotion happens.
      await ctx.prisma.user.update({ where: { username: 'root' }, data: { role: 'admin' } });
      expect((await prov().resolve(claims({ subject: 'a1', groups: [] }), admins)).role).toBe('user');
      // Without admin groups configured the role is left alone.
      await ctx.prisma.user.update({ where: { id: u.id }, data: { role: 'admin' } });
      expect((await prov().resolve(claims({ subject: 'a1', groups: [] }), policy)).role).toBe('admin');
    });
  });

  describe('forward-auth', () => {
    const forward = (remoteAddress: string, headers: Record<string, string> = {}) =>
      ctx.app.inject({ method: 'POST', url: '/api/auth/forward', remoteAddress, headers });

    beforeEach(async () => {
      expect((await putSso({ forwardAuth: { enabled: true, trustedProxies: ['10.0.0.0/8', '::1'], adminGroups: ['admins'] } })).statusCode).toBe(200);
    });

    it('logs in from a trusted proxy and provisions the user', async () => {
      const res = await forward('10.1.2.3', { 'remote-user': 'fred', 'remote-email': 'fred@example.com', 'remote-name': 'Fred F', 'remote-groups': 'staff,admins' });
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ username: 'fred', displayName: 'Fred F', email: 'fred@example.com', role: 'admin' });
      expect(res.cookies.find((c) => c.name === 'synclet_refresh')).toBeTruthy();
      const user = await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'fred' }, include: { identities: true } });
      expect(user.lastLoginAt).toBeInstanceOf(Date);
      expect(user.identities).toEqual([expect.objectContaining({ provider: 'forward', subject: 'fred' })]);
      // IPv4-mapped peer address, same user.
      const again = await forward('::ffff:10.9.9.9', { 'remote-user': 'fred' });
      expect(again.statusCode).toBe(200);
      expect(again.json().user.id).toBe(user.id);
    });

    it('ends the session of the refresh cookie the browser still sent', async () => {
      const old = (await forward('10.1.2.3', { 'remote-user': 'fred' })).cookies.find((c) => c.name === 'synclet_refresh')!.value;
      const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/forward', remoteAddress: '10.1.2.3', headers: { 'remote-user': 'fred' }, cookies: { synclet_refresh: old } });
      expect(res.statusCode).toBe(200);
      const refresh = (rt: string) => ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt } });
      expect((await refresh(old)).statusCode).toBe(401);
      expect((await refresh(res.cookies.find((c) => c.name === 'synclet_refresh')!.value)).statusCode).toBe(200);
    });

    it('ignores headers from untrusted peers, including spoofed X-Forwarded-For', async () => {
      for (const peer of ['192.168.1.5', '11.0.0.1', '::2']) {
        const res = await forward(peer, { 'remote-user': 'root', 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '10.0.0.1' });
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('unauthorized');
      }
      expect((await forward('10.0.0.1')).statusCode).toBe(401); // trusted, but no user header
      expect(await ctx.prisma.identity.count({ where: { provider: 'forward' } })).toBe(0);
    });

    it('does not take over local accounts with the same name', async () => {
      const res = await forward('10.0.0.1', { 'remote-user': 'root' });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.username).toBe('root-2');
    });

    it('is off when disabled', async () => {
      await putSso({ forwardAuth: { enabled: false } });
      expect((await forward('10.0.0.1', { 'remote-user': 'fred' })).statusCode).toBe(401);
    });
  });

  describe('password login rules', () => {
    const login = (loginName: string, password: string) =>
      ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: loginName, password } });

    it('records lastLoginAt', async () => {
      expect((await login('root', ADMIN_PW)).statusCode).toBe(200);
      expect((await ctx.prisma.user.findUniqueOrThrow({ where: { username: 'root' } })).lastLoginAt).toBeInstanceOf(Date);
    });

    it('disabled for users, admins still log in; emergency restores it and disables SSO', async () => {
      await createUser('bob');
      await enableOidc();
      await putSso({ passwordLoginForUsers: false, forwardAuth: { enabled: true, trustedProxies: ['10.0.0.0/8'] } });

      const denied = await login('bob', 'user password 123');
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('password_login_disabled');
      expect((await login('bob', 'wrong password')).statusCode).toBe(401); // no hint without the right password
      expect((await login('root', ADMIN_PW)).statusCode).toBe(200);
      expect(await ctx.app.get(SsoSettingsService).isPasswordLoginAllowed({ role: 'user' })).toBe(false);
      expect(await ctx.app.get(SsoSettingsService).isPasswordLoginAllowed({ role: 'admin' })).toBe(true);

      ctx.config.ssoEmergency = true;
      expect((await login('bob', 'user password 123')).statusCode).toBe(200);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/methods' })).json())
        .toEqual({ password: true, oidc: { enabled: false, label: 'Single Sign-on' }, forwardAuth: false, emergency: true });
      expect(ssoError(await ctx.app.inject({ method: 'GET', url: '/api/auth/oidc/start' }))).toBe('oidc_disabled');
      expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/forward', remoteAddress: '10.0.0.1', headers: { 'remote-user': 'bob' } })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/admin/sso', headers: auth() })).json().emergency).toBe(true);
    });
  });
});
