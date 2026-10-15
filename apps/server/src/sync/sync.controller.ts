import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SyncAccount, SyncChange, SyncChangesPage, SyncChildrenPage, SyncItem } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService, DOWNLOAD_TOKEN_TTL_S, PREVIEW_TOKEN_TTL_S } from '../auth/auth.service';
import { AllowDownloadToken, CurrentUser } from '../auth/current-user.decorator';
import { ServerConfigService } from '../auth/server-config.service';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DerivedStore } from '../derivatives/derived-store';
import { FilesService, itemEtag, OnConflict } from '../files/files.service';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { etagList, first, HeaderMap, rawBody, SANDBOX_CSP, sendFile, unquote } from './http-content';
import { SerializerService } from './serializer.service';
import { parseSyncId, ROOT_ID, toSyncId, UUID } from './sync-ids';

const CreateBody = z.object({ parentId: z.string(), type: z.literal('folder'), name: z.string(), onConflict: z.enum(['fail', 'rename']).optional() });
const PatchBody = z.object({ name: z.string().optional(), parentId: z.string().optional() });

const modifiedAt = (h: HeaderMap) => {
  const raw = first(h['x-synclet-modified-at']) ?? first(h['x-buro-modified-at']);
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const clampLimit = (raw: string | undefined) => Math.min(Math.max(Math.floor(Number(raw)) || 500, 1), 1000);

@Controller('sync/v1')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly journal: JournalService,
    private readonly serializer: SerializerService,
    private readonly serverConfig: ServerConfigService,
    private readonly auth: AuthService,
    private readonly derived: DerivedStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Resolves a sync id to a live row (null for root). */
  private async resolve(user: AuthUser, rawId: string): Promise<Item | null> {
    const parsed = parseSyncId(rawId);
    if (!parsed) throw new SyncError('invalid_request', 'invalid id');
    if (parsed.kind === 'root') return null;
    const row = await this.prisma.item.findFirst({ where: { id: parsed.uuid, ownerId: user.id, deletedAt: null, type: parsed.kind } });
    if (!row) throw new SyncError('not_found');
    return row;
  }

  private async resolveFile(user: AuthUser, rawId: string): Promise<Item> {
    const row = await this.resolve(user, rawId);
    if (!row || row.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    return row;
  }

  private async resolveParent(user: AuthUser, rawId: string): Promise<string | null> {
    const row = await this.resolve(user, rawId);
    if (row && row.type !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    return row?.id ?? null;
  }

  private async one(user: AuthUser, row: Item): Promise<SyncItem> {
    return (await this.serializer.toSyncItems(user, [row]))[0];
  }

  private rawBody(body: unknown, headers: HeaderMap) {
    return rawBody(body, headers, this.config.maxUploadBytes);
  }

  @Get('account')
  async account(@CurrentUser() user: AuthUser): Promise<SyncAccount> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const used = await this.prisma.item.aggregate({ where: { ownerId: user.id, deletedAt: null }, _sum: { size: true } });
    const { serverId } = await this.serverConfig.get();
    return {
      userId: u.id, email: u.email, displayName: u.displayName,
      organizationId: `${serverId}:${u.id}`, organizationName: 'Synclet', slug: u.username,
      canWrite: true, areas: { personal: true, shared: false, customers: false, projects: false },
      quotaBytes: 0, usedBytes: Number(used._sum.size ?? 0n), maxUploadBytes: this.config.maxUploadBytes,
      cursor: await this.journal.currentCursor(user.id),
    };
  }

  @Get('cursor')
  async cursor(@CurrentUser() user: AuthUser) {
    return { cursor: await this.journal.currentCursor(user.id) };
  }

  @Get('changes')
  async changes(@CurrentUser() user: AuthUser, @Query('cursor') cursor = '', @Query('limit') limitRaw?: string): Promise<SyncChangesPage> {
    const page = await this.journal.changesSince(user.id, cursor, clampLimit(limitRaw));
    const ids = page.entries.map((e) => e.itemId);
    const rows = await this.prisma.item.findMany({ where: { id: { in: ids }, ownerId: user.id, deletedAt: null } });
    const items = await this.serializer.toSyncItems(user, rows);
    const live = new Map(rows.map((r, i) => [r.id, items[i]]));
    // Tombstones are purged long before the journal is trimmed: a missing row is a delete,
    // its sync id comes from the journal's itemType.
    const changes: SyncChange[] = page.entries.map((e) => {
      const item = live.get(e.itemId);
      return item ? { op: 'upsert', item } : { op: 'delete', id: toSyncId({ id: e.itemId, type: e.itemType }) };
    });
    return { changes, cursor: page.cursor, hasMore: page.hasMore };
  }

  @Get('items/:id')
  async item(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<SyncItem> {
    const row = await this.resolve(user, id);
    return row ? this.one(user, row) : this.serializer.rootItem(user);
  }

  @Get('items/:id/children')
  async children(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('pageToken') pageToken?: string, @Query('limit') limitRaw?: string): Promise<SyncChildrenPage> {
    const cursor = await this.journal.currentCursor(user.id); // state before reading the first page
    const parent = await this.resolve(user, id);
    if (parent && parent.type !== 'folder') throw new SyncError('invalid_request', 'not a folder');
    const limit = clampLimit(limitRaw);
    // Keyset: "<0|1>:<uuid>" – folders (0) before files (1), then by id.
    let rank = -1;
    let afterId = '';
    if (pageToken) {
      const m = /^([01]):(.+)$/.exec(pageToken);
      if (!m || !UUID.test(m[2])) throw new SyncError('invalid_request', 'invalid pageToken');
      rank = Number(m[1]);
      afterId = m[2];
    }
    const where = { ownerId: user.id, parentId: parent?.id ?? null, deletedAt: null };
    const folders = rank <= 0
      ? await this.prisma.item.findMany({ where: { ...where, type: 'folder', ...(rank === 0 ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: limit + 1 })
      : [];
    const remaining = limit + 1 - folders.length;
    const fileRows = remaining > 0
      ? await this.prisma.item.findMany({ where: { ...where, type: 'file', ...(rank === 1 ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: remaining })
      : [];
    const all = [...folders, ...fileRows];
    const pageRows = all.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextPageToken = all.length > limit && last ? `${last.type === 'folder' ? 0 : 1}:${last.id}` : null;
    return { items: await this.serializer.toSyncItems(user, pageRows), nextPageToken, cursor };
  }

  /**
   * Short-lived URL for a browser download (`purpose` omitted: 60 s, attachment), or with
   * `purpose=preview` a 6 h token for inline `<img>`/`<video>`/`<iframe>` use: the URL has no
   * `download=1`, and the token is also accepted by the thumbnail route.
   */
  @Post('items/:id/download-token')
  async downloadToken(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('purpose') purpose?: string) {
    if (purpose !== undefined && purpose !== 'download' && purpose !== 'preview') throw new SyncError('invalid_request', 'invalid purpose');
    const row = await this.resolveFile(user, id);
    const syncId = toSyncId(row);
    const preview = purpose === 'preview';
    const ttl = preview ? PREVIEW_TOKEN_TTL_S : DOWNLOAD_TOKEN_TTL_S;
    const dt = await this.auth.signDownloadToken(user.id, syncId, ttl);
    const query = `${preview ? '' : 'download=1&'}dt=${encodeURIComponent(dt)}`;
    return {
      url: `/api/sync/v1/items/${syncId}/content?${query}`,
      token: dt,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  @Get('items/:id/content')
  @AllowDownloadToken()
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('download') download: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const parsed = parseSyncId(id);
    if (!parsed) throw new SyncError('invalid_request', 'invalid id');
    if (parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const { item, abs } = await this.files.openRead(user, parsed.uuid);
    return sendFile(req, reply, item, abs, { download: download === '1' });
  }

  /**
   * Thumbnail (always re-encoded webp, never the original bytes – an SVG is only ever served
   * rasterized). 404 until the worker has produced it.
   */
  @Get('items/:id/thumbnail')
  @AllowDownloadToken()
  async thumbnail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('size') sizeRaw: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const size = sizeRaw === undefined || sizeRaw === '256' ? 256 : sizeRaw === '1024' ? 1024 : null;
    if (size === null) throw new SyncError('invalid_request', 'size must be 256 or 1024');
    const row = await this.resolveFile(user, id);
    const sha = row.contentHash;
    if (!sha) throw new SyncError('not_found', 'no thumbnail');
    const job = await this.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha, kind: 'thumb' } }, select: { status: true } });
    if (job?.status !== 'done') throw new SyncError('not_found', 'no thumbnail');
    const fh = await open(this.derived.pathFor(sha, 'thumb', size), constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch(() => { throw new SyncError('not_found', 'no thumbnail'); });
    let handedOver = false;
    try {
      const st = await fh.stat();
      const tag = `${sha}-${size}`;
      reply.header('ETag', `"${tag}"`).header('Cache-Control', 'private, max-age=31536000, immutable')
        .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', SANDBOX_CSP)
        .header('Referrer-Policy', 'no-referrer');
      if (etagList(req.headers['if-none-match']).includes(tag)) return reply.status(304).send();
      reply.header('Content-Type', 'image/webp').header('Content-Length', st.size);
      handedOver = true;
      return reply.send(fh.createReadStream());
    } finally {
      if (!handedOver) await fh.close();
    }
  }

  @Put('items/:id/content')
  async replace(@CurrentUser() user: AuthUser, @Param('id') id: string, @Headers() headers: HeaderMap, @Body() body: unknown): Promise<SyncItem> {
    const row = await this.resolveFile(user, id);
    const ifMatch = unquote(first(headers['if-match']));
    if (!ifMatch) throw new SyncError('precondition_required', 'If-Match required');
    // `*` = any current version. An unindexed edit on the host still yields 412 (it is recorded
    // as a new version first), so host changes are never silently overwritten.
    const m = ifMatch === '*' ? null : /^v(\d+)$/.exec(ifMatch);
    if (ifMatch !== '*' && !m) throw new SyncError('conflict', 'unknown etag', row);
    const stream = this.rawBody(body, headers);
    const updated = await this.files.replaceContent(user, row.id, stream, { ifMatchVersion: m ? Number(m[1]) : null, modifiedAt: modifiedAt(headers) });
    return this.one(user, updated);
  }

  @Post('items/upload')
  @HttpCode(201)
  async upload(
    @CurrentUser() user: AuthUser,
    @Query('parentId') parentId: string = ROOT_ID,
    @Query('name') name: string = '',
    @Query('onConflict') onConflict: string = 'fail',
    @Headers() headers: HeaderMap,
    @Body() body: unknown,
  ): Promise<SyncItem> {
    if (onConflict !== 'fail' && onConflict !== 'rename') throw new SyncError('invalid_request', 'invalid onConflict');
    const pid = await this.resolveParent(user, parentId);
    const stream = this.rawBody(body, headers);
    const row = await this.files.upload(user, pid, name, stream, { onConflict: onConflict as OnConflict, modifiedAt: modifiedAt(headers) });
    return this.one(user, row);
  }

  @Post('items')
  @HttpCode(201)
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<SyncItem> {
    const pid = await this.resolveParent(user, body.parentId);
    return this.one(user, await this.files.createFolder(user, pid, body.name, body.onConflict ?? 'fail'));
  }

  @Patch('items/:id')
  async patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>, @Headers('if-match') ifMatchRaw?: string): Promise<SyncItem> {
    const row = await this.resolve(user, id);
    if (!row) throw new SyncError('forbidden', 'root cannot be changed');
    const current = await this.one(user, row);
    // The client's If-Match is checked against the etag it was served (for folders not derived
    // from updatedAt, see folderEtag). The row's internal etag is then handed to FilesService,
    // which re-checks it under the user lock, so a change in between still yields 412.
    const ifMatch = unquote(ifMatchRaw);
    let guard: { ifMatchEtag?: string } = {};
    if (ifMatch && ifMatch !== '*') {
      if (ifMatch !== current.etag) throw new SyncError('conflict', 'etag mismatch', row);
      guard = { ifMatchEtag: itemEtag(row) };
    }
    const parentId = body.parentId === undefined ? undefined : await this.resolveParent(user, body.parentId);
    // Sending the current display name (possibly with a "(2)" suffix) keeps the stored name …
    const keepsDisplayName = body.name !== undefined && body.name === current.name;
    const name = body.name === undefined || keepsDisplayName ? undefined : body.name;
    try {
      return await this.one(user, await this.files.update(user, row.id, { name, parentId }, guard));
    } catch (e) {
      // … except on a move where the stored name is taken at the target but the display name is free.
      const retry = e instanceof SyncError && e.code === 'name_conflict' && keepsDisplayName && current.name !== row.name && parentId !== undefined;
      if (!retry) throw e;
      return this.one(user, await this.files.update(user, row.id, { name: current.name, parentId }, guard));
    }
  }

  @Delete('items/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const row = await this.resolve(user, id);
    if (!row) throw new SyncError('forbidden', 'root cannot be deleted');
    await this.files.remove(user, row.id);
  }
}
