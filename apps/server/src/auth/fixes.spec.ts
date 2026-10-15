import type { ExecutionContext } from '@nestjs/common';
import { createTestApp, TestContext } from '../../test/context';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { ALLOW_DT } from './current-user.decorator';

describe('auth fixes', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  const setup = () =>
    ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });

  it('concurrent refreshes with the same token: at most one succeeds', async () => {
    const rt = (await setup()).cookies.find((c) => c.name === 'synclet_refresh')!.value;
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt } })),
    );
    expect(results.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r.statusCode === 401).length).toBeGreaterThanOrEqual(3);
  });

  it('login for an unknown user returns 401', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'nobody', password: 'whatever long' } });
    expect(res.statusCode).toBe(401);
  });

  it('admin password reset revokes existing refresh sessions', async () => {
    const admin = (await setup()).json().accessToken;
    const auth = { authorization: `Bearer ${admin}` };
    const anna = (await ctx.app.inject({ method: 'POST', url: '/api/admin/users', headers: auth, payload: { username: 'anna', displayName: 'Anna', password: 'another long password' } })).json();
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' } });
    const rt = login.cookies.find((c) => c.name === 'synclet_refresh')!.value;
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, headers: auth, payload: { password: 'brand new password' } });
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt } })).statusCode).toBe(401);
  });

  describe('download token path', () => {
    async function fixture() {
      const body = (await setup()).json();
      const userId = body.user.id as string;
      const auth = ctx.app.get(AuthService);
      const guard = ctx.app.get(AuthGuard);
      const run = (opts: { allowDt: boolean; headers?: Record<string, string>; query?: Record<string, string>; id?: string }) => {
        const req: Record<string, unknown> = { headers: opts.headers ?? {}, query: opts.query ?? {}, params: { id: opts.id ?? 'f_1' } };
        const handler = () => undefined;
        Reflect.defineMetadata?.(ALLOW_DT, opts.allowDt, handler);
        const ectx = { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => class {} } as unknown as ExecutionContext;
        // Reflector.get reads metadata set via SetMetadata, which is Reflect metadata on the handler.
        return guard.canActivate(ectx).then(() => req.user);
      };
      return { userId, access: body.accessToken as string, auth, run };
    }

    it('accepts dt only with ALLOW_DT and a matching item', async () => {
      const f = await fixture();
      const dl = await f.auth.signDownloadToken(f.userId, 'f_1');
      await expect(f.run({ allowDt: true, query: { dt: dl } })).resolves.toMatchObject({ id: f.userId });
      await expect(f.run({ allowDt: false, query: { dt: dl } })).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(f.run({ allowDt: true, query: { dt: dl }, id: 'f_2' })).rejects.toMatchObject({ code: 'unauthorized' });
    });

    it('rejects an access JWT as dt and a dl token as Bearer', async () => {
      const f = await fixture();
      const dl = await f.auth.signDownloadToken(f.userId, 'f_1');
      await expect(f.run({ allowDt: true, query: { dt: f.access } })).rejects.toMatchObject({ code: 'unauthorized' });
      await expect(f.run({ allowDt: true, headers: { authorization: `Bearer ${dl}` } })).rejects.toMatchObject({ code: 'unauthorized' });
    });
  });
});
