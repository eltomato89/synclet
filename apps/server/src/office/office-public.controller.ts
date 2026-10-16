import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimiter } from '../auth/rate-limit';
import { ipKey } from '../common/ip-key';
import { SyncError } from '../common/sync-error';
import { FilesService } from '../files/files.service';
import { sendFile } from '../sync/http-content';
import { CallbackResult, OfficeService } from './office.service';

/** Per client address. The Document Server is usually one client fetching for every editor. */
const limiter = new RateLimiter({ capacity: 300, refillPerSec: 10 });

/**
 * Routes for the Document Server. No user login: access only with the signed file token from the
 * editor config; the callback body must additionally be signed with OFFICE_JWT_SECRET.
 */
@Controller('office/files')
export class OfficePublicController {
  constructor(private readonly office: OfficeService, private readonly files: FilesService) {}

  private limit(req: FastifyRequest, reply: FastifyReply) {
    const key = ipKey(req.ip);
    if (limiter.take(key)) return;
    reply.header('Retry-After', String(Math.max(1, limiter.retryAfterSec(key))));
    throw new SyncError('rate_limited', 'too many requests, try again later');
  }

  @Get(':id/content')
  async content(@Param('id') id: string, @Query('t') t: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    this.limit(req, reply);
    const { user, itemId } = await this.office.contentTarget(id, t);
    const { item, abs } = await this.files.openRead(user, itemId);
    return sendFile(req, reply, item, abs, { download: false });
  }

  @Post(':id/callback')
  @HttpCode(200)
  async callback(
    @Param('id') id: string,
    @Query('t') t: string | undefined,
    @Body() body: unknown,
    @Headers('authorization') auth: string | undefined,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CallbackResult> {
    this.limit(req, reply);
    return this.office.callback(id, t, body, auth);
  }
}
