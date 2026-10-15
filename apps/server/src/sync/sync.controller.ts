import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SyncAccount, SyncChange, SyncChangesPage, SyncChildrenPage, SyncItem } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { open } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { AllowDownloadToken, CurrentUser } from '../auth/current-user.decorator';
import { ServerConfigService } from '../auth/server-config.service';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { FilesService, itemEtag, OnConflict } from '../files/files.service';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseRange } from './range';
import { mimeFor, SerializerService } from './serializer.service';
import { parseSyncId, ROOT_ID, toSyncId, UUID } from './sync-ids';

const CreateBody = z.object({ parentId: z.string(), type: z.literal('folder'), name: z.string(), onConflict: z.enum(['fail', 'rename']).optional() });
const PatchBody = z.object({ name: z.string().optional(), parentId: z.string().optional() });

type HeaderMap = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const unquote = (v: string | undefined) => v?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
/** Entity tags of an If-None-Match / If-Match list, unquoted. */
const etagList = (v: string | string[] | undefined) => (first(v) ?? '').split(',').map((t) => unquote(t) ?? '').filter(Boolean);
const modifiedAt = (h: HeaderMap) => {
  const raw = first(h['x-synclet-modified-at']) ?? first(h['x-buro-modified-at']);
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const clampLimit = (raw: string | undefined) => Math.min(Math.max(Math.floor(Number(raw)) || 500, 1), 1000);

/** RFC 5987 encoding (encodeURIComponent leaves `'()*!` alone, which are not attr-chars). */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const asciiFallback = (s: string) => s.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** User content must never run as script on the app origin (HTML/SVG uploads). PDFs stay viewable inline. */
const SANDBOX_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

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

  /**
   * Raw request body as a stream. The octet-stream parser hands us the request stream; an
   * empty body never reaches the parser. Anything else (JSON, text) would be silently lost.
   */
  private rawBody(body: unknown, headers: HeaderMap): Readable {
    const length = first(headers['content-length']);
    if (length !== undefined && Number(length) > this.config.maxUploadBytes) throw new SyncError('too_large');
    if (body instanceof Readable) return body;
    const hasBody = (length !== undefined && Number(length) > 0) || headers['transfer-encoding'] !== undefined;
    if ((body !== undefined && body !== null) || hasBody) {
      throw new SyncError('invalid_request', 'body must be sent as application/octet-stream');
    }
    const empty = new PassThrough();
    empty.end();
    return empty;
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

  @Post('items/:id/download-token')
  async downloadToken(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const row = await this.resolveFile(user, id);
    const syncId = toSyncId(row);
    const dt = await this.auth.signDownloadToken(user.id, syncId);
    return { url: `/api/sync/v1/items/${syncId}/content?download=1&dt=${encodeURIComponent(dt)}` };
  }

  @Get('items/:id/content')
  @AllowDownloadToken()
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('download') download: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const parsed = parseSyncId(id);
    if (!parsed) throw new SyncError('invalid_request', 'invalid id');
    if (parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const { item, abs } = await this.files.openRead(user, parsed.uuid);
    // Size and dates come from the opened file, so Content-Length always matches the bytes sent
    // (the file may have been edited on the host and not be indexed yet).
    const fh = await open(abs, 'r').catch(() => { throw new SyncError('not_found'); });
    let handedOver = false;
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new SyncError('not_found');
      const size = st.size;
      const tag = `v${item.version}`;
      reply.header('ETag', `"${tag}"`).header('Accept-Ranges', 'bytes').header('Last-Modified', st.mtime.toUTCString());
      const inm = etagList(req.headers['if-none-match']);
      if (inm.includes(tag) || inm.includes('*')) return reply.status(304).send();
      const range = parseRange(first(req.headers.range), size);
      if (range === 'invalid') {
        return reply.status(416).header('Content-Range', `bytes */${size}`).type('application/json')
          .send({ statusCode: 416, message: 'range not satisfiable', code: 'range_not_satisfiable' });
      }
      const mime = mimeFor(item.name);
      reply.header('Content-Type', mime).header('X-Content-Type-Options', 'nosniff');
      if (mime !== 'application/pdf') reply.header('Content-Security-Policy', SANDBOX_CSP);
      if (download === '1') {
        reply.header('Content-Disposition', `attachment; filename="${asciiFallback(item.name)}"; filename*=UTF-8''${rfc5987(item.name)}`);
      }
      handedOver = true;
      if (range) {
        reply.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1);
        return reply.send(fh.createReadStream({ start: range.start, end: range.end }));
      }
      reply.header('Content-Length', size);
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
    const m = /^v(\d+)$/.exec(ifMatch);
    if (!m) throw new SyncError('conflict', 'unknown etag', row);
    const stream = this.rawBody(body, headers);
    const updated = await this.files.replaceContent(user, row.id, stream, { ifMatchVersion: Number(m[1]), modifiedAt: modifiedAt(headers) });
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
