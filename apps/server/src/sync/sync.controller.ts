import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { ServerCapabilities, SyncAccount, SyncChange, SyncChangesPage, SyncChildrenPage, SyncItem, SyncSpace } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService, DOWNLOAD_TOKEN_TTL_S, PREVIEW_TOKEN_TTL_S } from '../auth/auth.service';
import { AllowDownloadToken, CurrentUser } from '../auth/current-user.decorator';
import { ServerConfigService } from '../auth/server-config.service';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import type { AuthUser, IndexSpace } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DerivativesGc } from '../derivatives/derivatives-gc';
import { DerivedStore } from '../derivatives/derived-store';
import { FolderThumbnails } from '../derivatives/folder-thumbnails';
import { previewKind } from '../derivatives/preview-kind';
import { decodeText, readPrefix, TextEncodingName } from '../derivatives/text-extract';
import { FilesService, itemEtag, OnConflict } from '../files/files.service';
import { JournalService } from '../journal/journal.service';
import { OfficeService } from '../office/office.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpaceAccess, type Role } from '../spaces/space-access.service';
import { apiSpaceId, PERSONAL_API_ID } from '../spaces/space-ids';
import { etagList, first, HeaderMap, rawBody, SANDBOX_CSP, sendFile, unquote } from './http-content';
import { ItemResolver, Resolved } from './item-resolver';
import { ItemView, mimeFor, SerializerService } from './serializer.service';
import { parseRootId, parseSyncId, ROOT_ID, spaceRootId, toSyncId, UUID } from './sync-ids';

const CreateBody = z.object({ parentId: z.string(), type: z.literal('folder'), name: z.string(), onConflict: z.enum(['fail', 'rename']).optional() });
const PatchBody = z.object({ name: z.string().optional(), parentId: z.string().optional() });

const modifiedAt = (h: HeaderMap) => {
  const raw = first(h['x-synclet-modified-at']) ?? first(h['x-buro-modified-at']);
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
/** preview-text returns at most this many bytes of the file. */
export const PREVIEW_TEXT_BYTES = 256 * 1024;
const TEXT_PREVIEW_KINDS = new Set(['text', 'markdown', 'code']);

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
    private readonly gc: DerivativesGc,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: SpaceAccess,
    private readonly resolver: ItemResolver,
    private readonly folderThumbs: FolderThumbnails,
  ) {}

  /**
   * Resolves a sync id in any space the caller can access with `need`: `{ space, item }`, where a
   * null item is the space root (`root` / `r_<uuid>`). No access → 404, read only → 403, missing → 503.
   */
  resolve(user: AuthUser, rawId: string, need: Role): Promise<Resolved> {
    return this.resolver.resolve(user, rawId, need);
  }

  private async resolveFile(user: AuthUser, rawId: string, need: Role): Promise<Resolved & { item: Item }> {
    const r = await this.resolve(user, rawId, need);
    if (!r.item || r.item.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    return r as Resolved & { item: Item };
  }

  /** A file or folder (not a space root). */
  private async resolveItem(user: AuthUser, rawId: string, need: Role): Promise<Resolved & { item: Item }> {
    const r = await this.resolve(user, rawId, need);
    if (!r.item) throw new SyncError('invalid_request', 'not a file or folder');
    return r as Resolved & { item: Item };
  }

  /** A folder (or space root) to create items in: needs write. */
  private async resolveParent(user: AuthUser, rawId: string): Promise<{ space: IndexSpace; parentId: string | null }> {
    const r = await this.resolve(user, rawId, 'write');
    if (r.item && r.item.type !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    return { space: r.space, parentId: r.item?.id ?? null };
  }

  /** A download token minted for another space (the item was moved since) is not valid here. */
  private checkDownloadSpace(user: AuthUser, space: IndexSpace) {
    if (user.downloadSpace !== undefined && user.downloadSpace !== space.id) throw new SyncError('not_found');
  }

  private async one(space: IndexSpace, row: Item, view: ItemView): Promise<SyncItem> {
    return (await this.serializer.toSyncItems(space, [row], view))[0];
  }

  /** The space of `?space=` (default: the caller's personal space); readable, else 404. */
  private space(user: AuthUser, apiId: string | undefined) {
    return this.resolver.space(user, apiId === undefined || apiId === '' ? PERSONAL_API_ID : apiId, 'read');
  }

  private rawBody(body: unknown, headers: HeaderMap) {
    return rawBody(body, headers, this.config.maxUploadBytes);
  }

  @Get('account')
  async account(@CurrentUser() user: AuthUser): Promise<SyncAccount> {
    const personal = await this.resolver.space(user, PERSONAL_API_ID, 'read');
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const used = await this.prisma.item.aggregate({ where: { spaceId: personal.space.id, deletedAt: null }, _sum: { size: true } });
    const { serverId } = await this.serverConfig.get();
    const spaces: SyncSpace[] = (await this.access.spacesFor(user)).map(({ space, role }): SyncSpace => {
      const status = space.status === 'missing' ? 'missing' : 'available';
      if (space.kind === 'personal') {
        return { id: PERSONAL_API_ID, kind: 'personal', name: 'Meine Dateien', rootId: ROOT_ID, canWrite: true, status: 'available' };
      }
      return {
        id: apiSpaceId(space, user), kind: space.kind === 'team' ? 'shared' : 'external', name: space.name,
        rootId: spaceRootId(space.id), canWrite: role === 'write' && status === 'available', status,
      };
    });
    return {
      userId: u.id, email: u.email, displayName: u.displayName,
      organizationId: `${serverId}:${u.id}`, organizationName: 'Synclet', slug: u.username,
      canWrite: true,
      spaces,
      areas: { personal: true, shared: false, customers: false, projects: false },
      quotaBytes: 0, usedBytes: Number(used._sum.size ?? 0n), maxUploadBytes: this.config.maxUploadBytes,
      cursor: await this.journal.currentCursor(personal.space.id),
    };
  }

  /** Optional server features, for clients to show or hide UI (versions, office editing). */
  @Get('capabilities')
  capabilities(): ServerCapabilities {
    // Same rule as the office routes (URL and shared secret), so clients never offer an editor that answers 503.
    const office = OfficeService.enabled(this.config);
    return { versions: this.config.versions, office: { enabled: office, url: office ? this.config.officeUrl : null } };
  }

  @Get('cursor')
  async cursor(@CurrentUser() user: AuthUser, @Query('space') spaceParam?: string) {
    const { space } = await this.space(user, spaceParam);
    return { cursor: await this.journal.currentCursor(space.id) };
  }

  /** Changes of one space (`?space=`, default personal: old clients see the unchanged personal feed). */
  @Get('changes')
  async changes(@CurrentUser() user: AuthUser, @Query('cursor') cursor = '', @Query('limit') limitRaw?: string, @Query('space') spaceParam?: string): Promise<SyncChangesPage> {
    const { space, view } = await this.space(user, spaceParam);
    const page = await this.journal.changesSince(space.id, cursor, clampLimit(limitRaw));
    const ids = page.entries.map((e) => e.itemId);
    // Rows that left the space (moved to another one) count as deleted here.
    const rows = await this.prisma.item.findMany({ where: { id: { in: ids }, spaceId: space.id, deletedAt: null } });
    const items = await this.serializer.toSyncItems(space, rows, view);
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
    const { space, item, view, role } = await this.resolve(user, id, 'read');
    if (item) return this.one(space, item, view);
    if (space.kind === 'personal') return this.serializer.rootItem(user);
    const row = await this.prisma.space.findUniqueOrThrow({ where: { id: space.id }, select: { id: true, name: true, createdAt: true } });
    return this.serializer.spaceRootItem(row, role);
  }

  @Get('items/:id/children')
  async children(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('pageToken') pageToken?: string, @Query('limit') limitRaw?: string, @Query('folderThumbnails') folderThumbnails?: string): Promise<SyncChildrenPage> {
    const { space, item: parent, view } = await this.resolve(user, id, 'read');
    const cursor = await this.journal.currentCursor(space.id); // state before reading the first page
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
    const where = { spaceId: space.id, parentId: parent?.id ?? null, deletedAt: null };
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
    // Folder mosaics only on request (the web grid): sync clients' enumerations never pay for them.
    const items = await this.serializer.toSyncItems(space, pageRows, view, { folderThumbs: folderThumbnails === '1' });
    return { items, nextPageToken, cursor };
  }

  /**
   * Short-lived URL for a browser download (`purpose` omitted: 60 s, attachment), or with
   * `purpose=preview` a 6 h token for inline `<img>`/`<video>`/`<iframe>` use: the URL has no
   * `download=1`, and the token is also accepted by the thumbnail route.
   */
  @Post('items/:id/download-token')
  async downloadToken(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('purpose') purpose?: string) {
    if (purpose !== undefined && purpose !== 'download' && purpose !== 'preview') throw new SyncError('invalid_request', 'invalid purpose');
    const preview = purpose === 'preview';
    // Folders: preview tokens only, for their thumbnail (a mosaic of the children's thumbnails).
    const { space, item: row } = preview ? await this.resolveItem(user, id, 'read') : await this.resolveFile(user, id, 'read');
    const syncId = toSyncId(row);
    const ttl = preview ? PREVIEW_TOKEN_TTL_S : DOWNLOAD_TOKEN_TTL_S;
    const dt = await this.auth.signDownloadToken(user.id, syncId, ttl, space.id);
    const query = `${preview ? '' : 'download=1&'}dt=${encodeURIComponent(dt)}`;
    return {
      url: row.type === 'folder' ? `/api/sync/v1/items/${syncId}/thumbnail?composite=1&${query}` : `/api/sync/v1/items/${syncId}/content?${query}`,
      token: dt,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  @Get('items/:id/content')
  @AllowDownloadToken()
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('download') download: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const parsed = parseSyncId(id);
    if (!parsed && !parseRootId(id)) throw new SyncError('invalid_request', 'invalid id');
    if (parsed?.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const { space, item: row } = await this.resolveFile(user, id, 'read');
    this.checkDownloadSpace(user, space);
    const { item, abs } = await this.files.openRead(space, row.id);
    return sendFile(req, reply, item, abs, { download: download === '1' });
  }

  /**
   * Thumbnail (always re-encoded webp, never the original bytes – an SVG is only ever served
   * rasterized). 404 until the worker has produced it. Folders, with `composite=1` only (sync
   * clients asking for every item keep getting 400): a mosaic of the children's thumbnails,
   * 404 when none of them has one.
   */
  @Get('items/:id/thumbnail')
  @AllowDownloadToken()
  async thumbnail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('size') sizeRaw: string | undefined, @Query('composite') composite: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const size = sizeRaw === undefined || sizeRaw === '256' ? 256 : sizeRaw === '1024' ? 1024 : null;
    if (size === null) throw new SyncError('invalid_request', 'size must be 256 or 1024');
    const { space, item: row } = composite === '1' ? await this.resolveItem(user, id, 'read') : await this.resolveFile(user, id, 'read');
    this.checkDownloadSpace(user, space);
    if (row.type === 'folder') {
      const mosaic = await this.folderThumbs.open(space.id, row.id, size);
      if (!mosaic) throw new SyncError('not_found', 'no thumbnail');
      // The picture behind this URL changes with the children: revalidated on every use.
      return this.sendThumb(req, reply, mosaic.fh, `${mosaic.key}-${size}`, 'private, no-cache');
    }
    const sha = row.contentHash;
    if (!sha) throw new SyncError('not_found', 'no thumbnail');
    const job = await this.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha, kind: 'thumb' } }, select: { status: true } });
    if (job?.status !== 'done') throw new SyncError('not_found', 'no thumbnail');
    const fh = await open(this.derived.pathFor(sha, 'thumb', size), constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch(async (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') await this.gc.requeueThumb(sha); // derived files lost: regenerate
        throw new SyncError('not_found', 'no thumbnail');
      });
    return this.sendThumb(req, reply, fh, `${sha}-${size}`, 'private, max-age=31536000, immutable');
  }

  private async sendThumb(req: FastifyRequest, reply: FastifyReply, fh: FileHandle, tag: string, cacheControl: string) {
    let handedOver = false;
    try {
      const st = await fh.stat();
      reply.header('ETag', `"${tag}"`).header('Cache-Control', cacheControl)
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

  /**
   * The first 256 KiB of a text/markdown/code file, decoded (UTF-8, latin1 fallback). Read from
   * disk on every request (never the possibly stale extracted text); 415 for other kinds.
   */
  @Get('items/:id/preview-text')
  async previewText(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ text: string; truncated: boolean; encoding: TextEncodingName }> {
    const { space, item: row } = await this.resolveFile(user, id, 'read');
    if (!TEXT_PREVIEW_KINDS.has(previewKind(row.name, mimeFor(row.name)))) {
      throw new SyncError('invalid_request', 'no text preview for this file type', undefined, 415);
    }
    const { abs } = await this.files.openRead(space, row.id);
    const { buf, size } = await readPrefix(abs, PREVIEW_TEXT_BYTES).catch(() => { throw new SyncError('not_found'); });
    const { text, encoding } = decodeText(buf);
    reply.header('Cache-Control', 'no-store');
    return { text: text.replace(/\u0000/g, ''), truncated: size > buf.length, encoding };
  }

  @Put('items/:id/content')
  async replace(@CurrentUser() user: AuthUser, @Param('id') id: string, @Headers() headers: HeaderMap, @Body() body: unknown): Promise<SyncItem> {
    const { space, item: row, view } = await this.resolveFile(user, id, 'write');
    const ifMatch = unquote(first(headers['if-match']));
    if (!ifMatch) throw new SyncError('precondition_required', 'If-Match required');
    // `*` = any current version. An unindexed edit on the host still yields 412 (it is recorded
    // as a new version first), so host changes are never silently overwritten.
    const m = ifMatch === '*' ? null : /^v(\d+)$/.exec(ifMatch);
    if (ifMatch !== '*' && !m) throw new SyncError('conflict', 'unknown etag', row);
    const stream = this.rawBody(body, headers);
    const updated = await this.files.replaceContent(space, row.id, stream, { ifMatchVersion: m ? Number(m[1]) : null, modifiedAt: modifiedAt(headers), by: user.id });
    return this.one(space, updated, view);
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
    const { space, parentId: pid } = await this.resolveParent(user, parentId);
    const stream = this.rawBody(body, headers);
    const row = await this.files.upload(space, pid, name, stream, { onConflict: onConflict as OnConflict, modifiedAt: modifiedAt(headers) });
    return this.one(space, row, { apiSpaceId: apiSpaceId(space, user), role: 'write' });
  }

  @Post('items')
  @HttpCode(201)
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>): Promise<SyncItem> {
    const { space, parentId: pid } = await this.resolveParent(user, body.parentId);
    return this.one(space, await this.files.createFolder(space, pid, body.name, body.onConflict ?? 'fail'), { apiSpaceId: apiSpaceId(space, user), role: 'write' });
  }

  @Patch('items/:id')
  async patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>, @Headers('if-match') ifMatchRaw?: string): Promise<SyncItem> {
    const { space, item: row, view } = await this.resolve(user, id, 'write');
    if (!row) throw new SyncError('forbidden', 'root cannot be changed');
    const current = await this.one(space, row, view);
    // The client's If-Match is checked against the etag it was served (for folders not derived
    // from updatedAt, see folderEtag). The row's internal etag is then handed to FilesService,
    // which re-checks it under the space lock, so a change in between still yields 412.
    const ifMatch = unquote(ifMatchRaw);
    let guard: { ifMatchEtag?: string } = {};
    if (ifMatch && ifMatch !== '*') {
      if (ifMatch !== current.etag) throw new SyncError('conflict', 'etag mismatch', row);
      guard = { ifMatchEtag: itemEtag(row) };
    }
    // A target folder in another space moves the item there (write needed on both spaces).
    const target = body.parentId === undefined ? null : await this.resolveParent(user, body.parentId);
    const parentId = target ? target.parentId : undefined;
    const targetSpace = target?.space ?? space;
    const targetView: ItemView = targetSpace.id === space.id ? view : { apiSpaceId: apiSpaceId(targetSpace, user), role: 'write' };
    // Sending the current display name (possibly with a "(2)" suffix) keeps the stored name …
    const keepsDisplayName = body.name !== undefined && body.name === current.name;
    const name = body.name === undefined || keepsDisplayName ? undefined : body.name;
    try {
      return await this.one(targetSpace, await this.files.update(space, row.id, { name, parentId, targetSpace }, guard), targetView);
    } catch (e) {
      // … except on a move where the stored name is taken at the target but the display name is free.
      const retry = e instanceof SyncError && e.code === 'name_conflict' && keepsDisplayName && current.name !== row.name && parentId !== undefined;
      if (!retry) throw e;
      return this.one(targetSpace, await this.files.update(space, row.id, { name: current.name, parentId, targetSpace }, guard), targetView);
    }
  }

  @Delete('items/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const { space, item: row } = await this.resolve(user, id, 'write');
    if (!row) throw new SyncError('forbidden', 'root cannot be deleted');
    await this.files.remove(space, row.id, user.id);
  }
}
