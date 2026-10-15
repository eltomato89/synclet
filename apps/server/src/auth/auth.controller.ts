import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from './auth.guard';
import { AuthService, REFRESH_COOKIE, REFRESH_TTL_MS } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { RateLimits } from './rate-limit';
import { UsersService } from './users.service';

export function setRefreshCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(REFRESH_COOKIE, token, { path: '/api/auth', httpOnly: true, sameSite: 'strict', secure, maxAge: REFRESH_TTL_MS / 1000 });
}

const LoginBody = z.object({ login: z.string().min(1), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly prisma: PrismaService, private readonly users: UsersService, private readonly limits: RateLimits) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.limits.takeIp(req.ip, reply);
    const key = body.login.trim().toLowerCase();
    if (!this.limits.login.take(key)) throw this.limits.limited(this.limits.login, key, reply);
    const { access, refreshToken } = await this.auth.login(body.login, body.password, req.headers['user-agent']);
    this.limits.login.reset(key);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { access, refreshToken } = await this.auth.refresh(req.cookies[REFRESH_COOKIE], req.headers['user-agent']);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.cookies[REFRESH_COOKIE]);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    return this.users.toPublic(await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }));
  }
}
