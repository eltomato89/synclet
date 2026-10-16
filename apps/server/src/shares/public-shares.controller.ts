import { Body, Controller, Get, Headers, HttpCode, Inject, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { PublicShareEntry, PublicShareInfo } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pipeline } from 'node:stream';
import { z } from 'zod';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, AppConfig } from '../config';
import { attachmentDisposition, first, HeaderMap, openNoFollow, rawBody, sendFile } from '../sync/http-content';
import { mimeFor } from '../sync/serializer.service';
import { ipKey } from '../common/ip-key';
import { ResolvedShare, ShareAuth, ShareRateLimits, UNLOCK_TTL_SEC, unlockCookieName } from './share-auth';
import { ShareQuotas } from './share-quotas';
import { SharesService } from './shares.service';
import { createZip } from './zip';

const UnlockBody = z.object({ password: z.string().max(1024) });

/** Content types that may be viewed inline even when downloads are disabled. */
const previewable = (mime: string) => /^(image|video|audio|text)\//.test(mime) || mime === 'application/pdf';

/**
 * Anonymous share API. No AuthGuard: every request is rate-limited per IP and resolved through
 * ShareAuth (token → active share → unlock cookie → live root → in-scope target).
 */
@Controller('public/shares')
export class PublicSharesController {
  private readonly log = new Logger(PublicSharesController.name);

  constructor(
    private readonly auth: ShareAuth,
    private readonly shares: SharesService,
    private readonly limits: ShareRateLimits,
    private readonly quotas: ShareQuotas,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Common headers + per-IP request limit. */
  private begin(req: FastifyRequest, reply: FastifyReply) {
    reply.header('X-Robots-Tag', 'noindex, nofollow').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'private, no-store');
    this.limits.take('requests', ipKey(req.ip), reply);
  }

  private async open(token: string, req: FastifyRequest, reply: FastifyReply): Promise<ResolvedShare> {
    this.begin(req, reply);
    return this.auth.resolve(token, req);
  }

  @Get(':token')
  async info(@Param('token') token: string, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<PublicShareInfo> {
    return this.shares.info(await this.open(token, req, reply));
  }

  @Post(':token/unlock')
  @HttpCode(204)
  async unlock(@Param('token') token: string, @Body(new ZodPipe(UnlockBody)) body: z.infer<typeof UnlockBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    this.begin(req, reply);
    this.limits.take('unlock', ipKey(req.ip), reply); // before any lookup or hashing
    const share = await this.auth.findActive(token);
    // Per share as well: many client addresses must not multiply the guesses against one password.
    if (share.passwordHash) this.limits.take('unlockShare', `unlock:${share.id}`, reply);
    const rs = await this.auth.load(share); // trashed item / disabled owner: 404 like every route
    if (!rs.share.passwordHash) return;
    if (!(await this.shares.checkPassword(share, body.password))) throw new SyncError('unauthorized', 'wrong password');
    reply.setCookie(unlockCookieName(share.id), await this.auth.signUnlock(share), {
      path: `/api/public/shares/${token}`, httpOnly: true, sameSite: 'lax', secure: this.config.secureCookies, maxAge: UNLOCK_TTL_SEC,
    });
  }

  @Get(':token/items')
  async items(@Param('token') token: string, @Query('folder') folder: string | undefined, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<PublicShareEntry[]> {
    return this.shares.children(await this.open(token, req, reply), folder);
  }

  @Get(':token/items/:itemId/content')
  async content(@Param('token') token: string, @Param('itemId') itemId: string, @Query('download') download: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const rs = await this.open(token, req, reply);
    const target = await this.auth.target(rs, itemId, 'file');
    const wantsDownload = download === '1';
    if (!rs.share.allowDownload && (wantsDownload || !previewable(mimeFor(target.name)))) {
      throw new SyncError('forbidden', 'downloads are disabled for this link');
    }
    const { item, abs } = await this.shares.fileForRead(rs, target);
    return sendFile(req, reply, item, abs, { download: wantsDownload });
  }

  @Get(':token/items/:itemId/thumbnail')
  async thumbnail(@Param('token') token: string, @Param('itemId') itemId: string, @Query('size') sizeRaw: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const rs = await this.open(token, req, reply);
    const size = sizeRaw === undefined || sizeRaw === '256' ? 256 : sizeRaw === '1024' ? 1024 : null;
    if (size === null) throw new SyncError('invalid_request', 'size must be 256 or 1024');
    const thumb = await this.shares.thumbnail(rs, itemId, size);
    const fh = await openNoFollow(thumb.path);
    const length = await fh.stat().then((st) => st.size, async (e) => { await fh.close(); throw e; });
    return reply
      .header('Content-Type', 'image/webp').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cache-Control', 'private, no-store')
      .header('Content-Length', length)
      .send(fh.createReadStream());
  }

  @Get(':token/zip')
  async zip(@Param('token') token: string, @Query('folder') folder: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const rs = await this.open(token, req, reply);
    if (!rs.share.allowDownload) throw new SyncError('forbidden', 'downloads are disabled for this link');
    if (rs.root.type !== 'folder') throw new SyncError('invalid_request', 'not a folder share');
    const target = await this.auth.target(rs, folder, 'folder');
    const release = this.quotas.acquireZip(rs.share.id, reply);
    let zip: ReturnType<typeof createZip>;
    try {
      zip = createZip(await this.shares.zipEntries(rs, target), this.log);
    } catch (e) {
      release();
      throw e;
    }
    // Client gone before the end: stop reading files and building the archive.
    reply.raw.on('close', () => {
      release();
      if (!reply.raw.writableFinished) zip.abort();
    });
    for (const ev of ['end', 'close', 'error']) zip.stream.once(ev, release);
    return reply
      .header('Content-Type', 'application/zip').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', attachmentDisposition(`${target.name}.zip`))
      .send(zip.stream);
  }

  @Post(':token/upload')
  @HttpCode(201)
  async upload(
    @Param('token') token: string,
    @Query('folder') folder: string | undefined,
    @Query('name') name: string | undefined,
    @Headers() headers: HeaderMap,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<PublicShareEntry> {
    const rs = await this.open(token, req, reply);
    const target = await this.shares.uploadTarget(rs, folder);
    const stream = rawBody(body, headers, this.config.maxUploadBytes);
    this.limits.take('upload', ipKey(req.ip), reply);
    const length = first(headers['content-length']);
    const meter = this.quotas.meterUpload(rs.share.id, length === undefined ? null : Number(length));
    return this.shares.upload(rs, target, name ?? '', pipeline(stream, meter, () => undefined));
  }
}
