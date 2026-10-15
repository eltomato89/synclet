import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { setRefreshCookie } from './auth.controller';
import { UsersService } from './users.service';

const SetupBody = z.object({
  username: z.string(),
  displayName: z.string().min(1).max(100),
  email: z.string().email().nullish(),
  password: z.string().min(10).max(200),
});

@Controller('setup')
export class SetupController {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService, private readonly auth: AuthService) {}

  @Get('status')
  async status() {
    return { needsSetup: (await this.prisma.user.count()) === 0 };
  }

  @Post()
  @HttpCode(201)
  async setup(@Body(new ZodPipe(SetupBody)) body: z.infer<typeof SetupBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if ((await this.prisma.user.count()) > 0) throw new SyncError('setup_done', 'setup already completed');
    const user = await this.users.create({ ...body, role: 'admin' });
    const { access, refreshToken } = await this.auth.issue(user, req.headers['user-agent']);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }
}
