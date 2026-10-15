import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { SyncItem } from '@synclet/shared';
import type { FileStore as TusFileStore } from '@tus/file-store';
import type { Server as TusServer, ServerOptions, Upload } from '@tus/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { AuthGuard } from '../auth/auth.guard';
import { APP_CONFIG, AppConfig } from '../config';
import { validateName } from '../common/names';
import { InsufficientStorageError } from '../common/storage-errors';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { FilesService, OnConflict } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { importEsm } from '../common/import-esm';
import { SerializerService } from '../sync/serializer.service';
import { parseSyncId, ROOT_ID } from '../sync/sync-ids';

export const TUS_PATH = '/api/sync/v1/uploads';
/** Unfinished uploads older than this are refused (410) and removed by maintenance. */
export const UPLOAD_EXPIRY_MS = 24 * 3600 * 1000;

type TusRequest = Parameters<NonNullable<ServerOptions['onIncomingRequest']>>[0];
type TusError = { status_code: number; body: string };

type TusModules = { Server: typeof import('@tus/server').Server; FileStore: typeof import('@tus/file-store').FileStore };
let tusModules: Promise<TusModules> | undefined;
/** Loaded once and sequentially (Jest's ESM linker fails on concurrent imports of shared deps). */
function loadTus(): Promise<TusModules> {
  tusModules ??= (async () => {
    const { Server } = await importEsm<typeof import('@tus/server')>('@tus/server');
    const { FileStore } = await importEsm<typeof import('@tus/file-store')>('@tus/file-store');
    return { Server, FileStore };
  })();
  return tusModules;
}

const tusError = (status_code: number, body: string): TusError => ({ status_code, body });

/** Resolved, validated `Upload-Metadata`. */
interface UploadMeta {
  /** Sync id as sent (default `root`). */
  parentId: string;
  /** Resolved live folder row id (null = user root). */
  parent: string | null;
  name: string;
  onConflict: OnConflict;
  modifiedAt: Date | null;
}

/**
 * Resumable uploads (tus 1.0) at /api/sync/v1/uploads. Parts are staged in /meta/uploads; the
 * user folder only ever sees the finished file, published through FilesService.upload.
 */
@Injectable()
export class TusService implements OnModuleInit {
  private readonly log = new Logger(TusService.name);
  private server!: TusServer;
  private store!: TusFileStore;
  /** Caller of each in-flight tus request (set by the route before handing over to tus). */
  private readonly callers = new WeakMap<IncomingMessage, AuthUser>();
  /** Uploads currently being published (tus releases its lock before onUploadFinish). */
  private readonly finishing = new Set<string>();
  /** Upload published by a request; its staged part is dropped once tus has answered. */
  private readonly published = new WeakMap<IncomingMessage, string>();
  readonly directory: string;

  constructor(
    private readonly guard: AuthGuard,
    private readonly files: FilesService,
    private readonly prisma: PrismaService,
    private readonly serializer: SerializerService,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.directory = path.join(config.metaRoot, 'uploads');
  }

  async onModuleInit(): Promise<void> {
    const { Server, FileStore } = await loadTus();
    // FileStore creates its directory asynchronously and throws uncaught on failure: do it first.
    await mkdir(this.directory, { recursive: true });
    this.store = new FileStore({ directory: this.directory, expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS });
    this.server = new Server({
      path: TUS_PATH,
      datastore: this.store,
      maxSize: this.config.maxUploadBytes,
      // Behind Caddy the public host/proto differ; a path-only Location is always right.
      relativeLocation: true,
      // Same-origin app: never emit Access-Control-Allow-Origin (the default would be `*`).
      allowedOrigins: [],
      namingFunction: (req) => `${this.caller(req).id}-${randomBytes(16).toString('hex')}`,
      onIncomingRequest: async (req, id) => {
        // Upload ids are namespaced by user; someone else's upload is indistinguishable from none.
        if (!id.startsWith(`${this.caller(req).id}-`)) throw tusError(404, 'The file for this url was not found\n');
        // Neither append to nor terminate an upload that is being published right now.
        if (this.finishing.has(id) && (req.method === 'PATCH' || req.method === 'DELETE')) throw tusError(423, 'Upload is being finished\n');
      },
      onUploadCreate: async (req, upload) => {
        const meta = await this.validateMeta(this.caller(req), upload.metadata);
        return { metadata: { ...upload.metadata, parentId: meta.parentId, onConflict: meta.onConflict } };
      },
      onUploadFinish: (req, upload) => this.finish(req, upload),
      onResponseError: async (_req, err) => {
        if (!(err instanceof SyncError)) return undefined;
        const body: Record<string, unknown> = { statusCode: err.status, message: err.message, code: err.code };
        if (err.itemRow) {
          const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: err.itemRow.ownerId } });
          body.item = (await this.serializer.toSyncItems(owner, [err.itemRow]))[0];
        }
        return { status_code: err.status, body: JSON.stringify(body) };
      },
    });
    const fastify = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (fastify) this.register(fastify);
  }

  /** Mounts the tus routes. Bodies are never parsed by Fastify: tus reads the raw request. */
  register(fastify: FastifyInstance): void {
    void fastify.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_req: FastifyRequest, _payload: Readable, done: (err: Error | null, body?: unknown) => void) => done(null));
      const handler = (req: FastifyRequest, reply: FastifyReply) => this.handle(req, reply);
      const methods = ['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS'] as const;
      scope.route({ method: [...methods], url: TUS_PATH, handler, exposeHeadRoute: false });
      scope.route({ method: [...methods], url: `${TUS_PATH}/:id`, handler, exposeHeadRoute: false });
    });
  }

  private async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.method !== 'OPTIONS') {
      try {
        this.callers.set(req.raw, await this.guard.resolveFromHeaders(req));
      } catch (e) {
        if (!(e instanceof SyncError)) throw e;
        await reply.status(e.status).header('Tus-Resumable', '1.0.0').send({ statusCode: e.status, message: e.message, code: e.code });
        return;
      }
    }
    reply.hijack();
    try {
      await this.server.handle(req.raw, reply.raw);
    } catch (e) {
      this.log.error(`tus ${req.method} failed: ${(e as Error).message}`);
      if (!reply.raw.headersSent) reply.raw.writeHead(500).end();
      else reply.raw.destroy();
    } finally {
      const id = this.published.get(req.raw);
      if (id) {
        await this.discard(id);
        this.finishing.delete(id);
      }
    }
  }

  private rawRequest(req: TusRequest): IncomingMessage | undefined {
    return (req as unknown as { runtime?: { node?: { req?: IncomingMessage } } }).runtime?.node?.req;
  }

  private caller(req: TusRequest): AuthUser {
    const raw = this.rawRequest(req);
    const user = raw && this.callers.get(raw);
    if (!user) throw tusError(401, 'Unauthorized\n'); // unreachable: the route authenticates first
    return user;
  }

  private async resolveParent(user: AuthUser, rawId: string): Promise<string | null> {
    const parsed = parseSyncId(rawId);
    if (!parsed) throw new SyncError('invalid_request', 'invalid parentId');
    if (parsed.kind === 'root') return null;
    if (parsed.kind !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    const row = await this.prisma.item.findFirst({ where: { id: parsed.uuid, ownerId: user.id, deletedAt: null, type: 'folder' } });
    if (!row) throw new SyncError('not_found', 'parent not found');
    return row.id;
  }

  private async validateMeta(user: AuthUser, metadata: Upload['metadata']): Promise<UploadMeta> {
    const m = metadata ?? {};
    const name = m.name ?? '';
    const nameError = validateName(name);
    if (nameError) throw new SyncError('invalid_name', `invalid name (${nameError})`);
    const parentId = m.parentId || ROOT_ID;
    const parent = await this.resolveParent(user, parentId);
    const onConflict = m.onConflict || 'rename';
    if (onConflict !== 'fail' && onConflict !== 'rename') throw new SyncError('invalid_request', 'invalid onConflict');
    let modifiedAt: Date | null = null;
    if (m.modifiedAt) {
      modifiedAt = new Date(m.modifiedAt);
      if (Number.isNaN(modifiedAt.getTime())) throw new SyncError('invalid_request', 'invalid modifiedAt');
    }
    return { parentId, parent, name, onConflict, modifiedAt };
  }

  /** Publishes a completed upload into the user folder and drops the staged part. */
  private async finish(req: TusRequest, upload: Upload): Promise<{ status_code: number; headers: Record<string, string>; body: string }> {
    const user = this.caller(req);
    // A retried empty PATCH at the final offset while we publish must not publish twice.
    if (this.finishing.has(upload.id)) throw tusError(423, 'Upload is being finished\n');
    this.finishing.add(upload.id);
    let item: SyncItem;
    try {
      const meta = await this.validateMeta(user, upload.metadata);
      const source = createReadStream(path.join(this.directory, upload.id));
      const row = await this.files.upload(user, meta.parent, meta.name, source, { onConflict: meta.onConflict, modifiedAt: meta.modifiedAt });
      item = (await this.serializer.toSyncItems(user, [row]))[0];
    } catch (e) {
      // Client errors (conflict, parent gone) cannot be fixed by retrying this upload: drop it.
      // Anything else (I/O, database, full disk = 507) keeps it; an empty PATCH at the final offset retries.
      if (e instanceof SyncError && !(e instanceof InsufficientStorageError)) await this.discard(upload.id);
      this.finishing.delete(upload.id);
      throw e;
    }
    // A final POST still reads the upload after this hook: handle() drops it once tus answered
    // (the id stays in `finishing` until then). A final PATCH does not, so drop it right away.
    const raw = this.rawRequest(req);
    if (req.method === 'POST' && raw) {
      this.published.set(raw, upload.id);
    } else {
      await this.discard(upload.id);
      this.finishing.delete(upload.id);
    }
    return {
      // A POST that completed the upload (creation-with-upload, empty file) must stay 201 with
      // its Location header; the final PATCH answers 200 with the item.
      status_code: req.method === 'POST' ? 201 : 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Synclet-Item': item.id },
      body: JSON.stringify(item),
    };
  }

  private async discard(id: string): Promise<void> {
    await this.store.remove(id).catch((e) => this.log.warn(`cannot remove staged upload ${id}: ${(e as Error).message ?? JSON.stringify(e)}`));
  }

  /** Removes unfinished uploads older than 24 h from /meta/uploads. */
  async expire(): Promise<number> {
    return this.server.cleanUpExpiredUploads();
  }
}
