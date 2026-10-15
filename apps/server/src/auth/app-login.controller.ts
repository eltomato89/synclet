import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ipKey } from '../common/ip-key';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { AppLoginService } from './app-login.service';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { RateLimits } from './rate-limit';

const Pkce = {
  clientId: z.string().min(1).max(40),
  redirectUri: z.string().min(1).max(200),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal('S256'),
};
const AuthorizeBody = z.object({ login: z.string().min(1).max(320), password: z.string().min(1).max(1024), ...Pkce });
const SessionBody = z.object(Pkce);
const TokenBody = z.object({
  code: z.string().min(1).max(200),
  codeVerifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
  clientId: z.string().min(1).max(40),
  redirectUri: z.string().min(1).max(200),
});
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(200) });

/** Native app login (OAuth 2.0 Authorization Code + PKCE); all routes are rate-limited per client IP. */
@Controller('auth/app')
export class AppLoginController {
  constructor(private readonly appLogin: AppLoginService, private readonly limits: RateLimits) {}

  @Get('client')
  client(@Query('clientId') clientId: string | undefined, @Query('redirectUri') redirectUri: string | undefined, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.limits.takeIp(ipKey(req.ip), reply);
    return this.appLogin.client(clientId ?? '', redirectUri ?? '');
  }

  @Post('authorize')
  @HttpCode(200)
  async authorize(@Body(new ZodPipe(AuthorizeBody)) body: z.infer<typeof AuthorizeBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const client = ipKey(req.ip);
    this.limits.takeIp(client, reply);
    const key = `${client}|${body.login.trim().toLowerCase()}`;
    if (this.limits.login.retryAfterSec(key) > 0) throw this.limits.limited(this.limits.login, key, reply); // before argon2
    let result;
    try {
      result = await this.appLogin.authorizeWithPassword(body.login, body.password, body);
    } catch (e) {
      if (e instanceof SyncError && e.code === 'unauthorized') this.limits.login.take(key); // only failures consume
      throw e;
    }
    this.limits.login.reset(key);
    return result;
  }

  @Post('authorize/session')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  authorizeSession(@CurrentUser() user: AuthUser, @Body(new ZodPipe(SessionBody)) body: z.infer<typeof SessionBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.limits.takeIp(ipKey(req.ip), reply);
    // A long-lived device token must not be escalated into a web session with a refresh token.
    if (user.deviceId) throw new SyncError('forbidden', 'device tokens cannot authorize app logins');
    return this.appLogin.authorizeForUser(user.id, body);
  }

  @Post('token')
  @HttpCode(200)
  token(@Body(new ZodPipe(TokenBody)) body: z.infer<typeof TokenBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.limits.takeIp(ipKey(req.ip), reply);
    return this.appLogin.token(body, req.headers['user-agent']);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.limits.takeIp(ipKey(req.ip), reply);
    return this.appLogin.refresh(body.refreshToken, req.headers['user-agent']);
  }
}
