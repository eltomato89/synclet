import { Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { LoginMethods } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ipKey } from '../common/ip-key';
import { SyncError } from '../common/sync-error';
import { setRefreshCookie } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { RateLimiter, RateLimits } from '../auth/rate-limit';
import { ForwardAuthService } from './forward-auth.service';
import { OIDC_COOKIE, OIDC_COOKIE_PATH, OIDC_COOKIE_TTL_S, OidcFlowError, OidcService, SsoErrorCode } from './oidc.service';
import { ProvisioningService } from './provisioning.service';
import { SsoSettingsService } from './sso-settings.service';

/** Public SSO endpoints: login methods, OIDC start/callback, forward-auth. */
@Controller('auth')
export class SsoController {
  private readonly log = new Logger('Sso');
  /** Per client IP: 30 burst, one more every 2 s (the web calls forward-auth on every load). */
  readonly limiter = new RateLimiter({ capacity: 30, refillPerSec: 1 / 2 });

  constructor(
    private readonly settings: SsoSettingsService,
    private readonly oidc: OidcService,
    private readonly forward: ForwardAuthService,
    private readonly provisioning: ProvisioningService,
    private readonly auth: AuthService,
    private readonly limits: RateLimits,
  ) {}

  @Get('methods')
  methods(): Promise<LoginMethods> {
    return this.settings.loginMethods();
  }

  @Get('oidc/start')
  async start(@Query('return') ret: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    try {
      if (!this.limiter.take(ipKey(req.ip))) throw new OidcFlowError('rate_limited');
      const { url, cookie } = await this.oidc.start(ret);
      reply.setCookie(OIDC_COOKIE, cookie, {
        // Lax: the IdP redirects back with a cross-site top-level GET.
        path: OIDC_COOKIE_PATH, httpOnly: true, sameSite: 'lax', secure: this.auth.config.secureCookies, maxAge: OIDC_COOKIE_TTL_S,
      });
      return reply.redirect(url, 302);
    } catch (e) {
      return this.fail(reply, e);
    }
  }

  @Get('oidc/callback')
  async callback(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const cookie = req.cookies[OIDC_COOKIE];
    reply.clearCookie(OIDC_COOKIE, { path: OIDC_COOKIE_PATH }); // one attempt per cookie
    try {
      if (!this.limiter.take(ipKey(req.ip))) throw new OidcFlowError('rate_limited');
      const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      const { claims, returnTo } = await this.oidc.callback(rawQuery, cookie);
      const policy = (await this.settings.effective()).oidc;
      if (!policy) throw new OidcFlowError('oidc_disabled');
      const user = await this.provisioning.resolve(claims, policy);
      const { refreshToken } = await this.auth.issueLogin(user, req.headers['user-agent']);
      setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
      return reply.redirect(returnTo, 302);
    } catch (e) {
      return this.fail(reply, e);
    }
  }

  @Post('forward')
  @HttpCode(200)
  async forwardAuth(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const key = ipKey(req.ip);
    if (!this.limiter.take(key)) throw this.limits.limited(this.limiter, key, reply);
    const user = await this.forward.authenticate({ headers: req.headers, peer: req.socket.remoteAddress });
    const { access, refreshToken } = await this.auth.issueLogin(user, req.headers['user-agent']);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }

  private fail(reply: FastifyReply, e: unknown) {
    let code: SsoErrorCode = 'server_error';
    if (e instanceof OidcFlowError) code = e.code;
    else if (e instanceof SyncError && (e.code === 'sso_not_allowed' || e.code === 'unauthorized')) code = e.code;
    if (code === 'server_error') this.log.error(`OIDC login failed: ${(e as Error)?.stack ?? String(e)}`);
    else this.log.warn(`OIDC login rejected (${code}): ${(e as Error)?.message}`);
    return reply.redirect(`/login?sso_error=${code}`, 302);
  }
}
