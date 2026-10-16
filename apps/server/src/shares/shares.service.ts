import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item, ShareLink } from '@prisma/client';
import type { AdminShareWire, CreateShareInput, PublicShareEntry, PublicShareInfo, ShareLinkWire } from '@synclet/shared';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { hashToken, randomToken } from '../auth/crypto';
import { assignDisplayNames } from '../common/names';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { APP_CONFIG, AppConfig } from '../config';
import { DerivativesGc } from '../derivatives/derivatives-gc';
import { DerivedStore } from '../derivatives/derived-store';
import { chooseFolderThumbs, FolderThumbnails } from '../derivatives/folder-thumbnails';
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { SpaceAccess, type Role } from '../spaces/space-access.service';
import { apiSpaceId } from '../spaces/space-ids';
import { PrismaService } from '../prisma/prisma.service';
import { openNoFollow } from '../sync/http-content';
import { mimeFor } from '../sync/serializer.service';
import { toSyncId, UUID } from '../sync/sync-ids';
import { parseItemId, ResolvedShare, ShareAuth } from './share-auth';
import { zipEntryName, type ZipEntrySource } from './zip';

export interface SharePatch {
  password?: string | null;
  expiresAt?: string | null;
  allowDownload?: boolean;
  allowUpload?: boolean;
}

/** New share tokens: 32 random bytes, base64url, no prefix (they end up in short /s/<token> links). */
const newToken = () => randomToken('');

const futureDate = (raw: string | null | undefined): Date | null | undefined => {
  if (raw === undefined || raw === null) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new SyncError('invalid_request', 'invalid expiresAt');
  if (d.getTime() <= Date.now()) throw new SyncError('invalid_request', 'expiresAt must be in the future');
  return d;
};

@Injectable()
export class SharesService {
  private readonly log = new Logger(SharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SpaceAccess,
    private readonly auth: ShareAuth,
    private readonly files: FilesService,
    private readonly store: ItemStore,
    private readonly derived: DerivedStore,
    private readonly gc: DerivativesGc,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly folderThumbs: FolderThumbnails,
  ) {}

  // ---------------------------------------------------------------- owner API

  /** `viewer`: whose API space id the wire carries (`personal` for the viewer's own personal space). */
  private async toWire(share: ShareLink, item: Pick<Item, 'id' | 'name' | 'type'>, viewer: { id: string }, itemTrashed = false, withUrl = true): Promise<ShareLinkWire> {
    let url = '';
    if (withUrl) try {
      url = this.auth.url(await this.auth.openToken(share.tokenEnc, share.id));
    } catch (e) {
      // Only if the server secret changed: the link still works, but the owner must rotate to copy it.
      this.log.error(`cannot decrypt token of share ${share.id}: ${(e as Error).message}`);
    }
    return {
      id: share.id, itemId: toSyncId(item), itemName: item.name, itemType: item.type, url,
      hasPassword: share.passwordHash !== null, expiresAt: share.expiresAt?.toISOString() ?? null,
      allowDownload: share.allowDownload, allowUpload: share.allowUpload,
      createdAt: share.createdAt.toISOString(), revokedAt: share.revokedAt?.toISOString() ?? null, hits: share.hits,
      itemTrashed, spaceId: apiSpaceId({ id: share.spaceId }, viewer),
    };
  }

  private async liveItem(space: { id: string }, id: string): Promise<Item> {
    const item = await this.prisma.item.findFirst({ where: { id, spaceId: space.id, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    return item;
  }

  /** Access of `user` to a space: no access → 404 (as for a missing item), read only → 403, missing → 503. */
  private async requireSpace(user: IndexUser, spaceId: string, need: Role): Promise<void> {
    try {
      await this.access.require(user, spaceId, need);
    } catch (e) {
      if (e instanceof SyncError && e.code === 'not_found') throw new SyncError('not_found');
      throw e;
    }
  }

  /** An active (not revoked) share of `user` with its live item, still writable by them; anything else is 404 (read only: 403). */
  private async ownShare(user: IndexUser, id: string): Promise<{ share: ShareLink; item: Item }> {
    if (!UUID.test(id)) throw new SyncError('not_found');
    const share = await this.prisma.shareLink.findFirst({ where: { id, ownerId: user.id, revokedAt: null } });
    if (!share) throw new SyncError('not_found');
    await this.requireSpace(user, share.spaceId, 'write');
    return { share, item: await this.liveItem({ id: share.spaceId }, share.itemId) };
  }

  private static checkUpload(item: Item, allowUpload: boolean | undefined) {
    if (allowUpload && item.type !== 'folder') throw new SyncError('invalid_request', 'uploads are only possible into shared folders');
  }

  private static async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async create(user: IndexUser, input: CreateShareInput): Promise<ShareLinkWire> {
    const itemId = parseItemId(input.itemId);
    if (!itemId) throw new SyncError('invalid_request', 'invalid itemId');
    // Any space: the item must be live and its space writable by the creator.
    const item = await this.prisma.item.findFirst({ where: { id: itemId, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    await this.requireSpace(user, item.spaceId, 'write');
    SharesService.checkUpload(item, input.allowUpload);
    const id = randomUUID();
    const token = newToken();
    const share = await this.prisma.shareLink.create({
      data: {
        id, ownerId: user.id, spaceId: item.spaceId, itemId: item.id, tokenHash: hashToken(token), tokenEnc: await this.auth.sealToken(token, id),
        passwordHash: input.password ? await SharesService.hashPassword(input.password) : null,
        expiresAt: futureDate(input.expiresAt) ?? null,
        allowDownload: input.allowDownload ?? true, allowUpload: input.allowUpload ?? false,
      },
    });
    return this.toWire(share, item, user);
  }

  /**
   * Items of `ids` (in space `spaceId`) that are in the trash: the root of a trash entry or any
   * node of its manifest. Name and type as recorded at delete time.
   */
  private async trashedItems(spaceId: string, ids: string[]): Promise<Map<string, Pick<Item, 'id' | 'name' | 'type'>>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.$queryRaw<{ id: string; name: string | null; path: string | null; type: string }[]>`
      SELECT t."itemId"::text AS id, t.name, NULL AS path, t.type::text AS type
      FROM "TrashEntry" t WHERE t."spaceId" = ${spaceId}::uuid AND t."itemId"::text = ANY(${ids}::text[])
      UNION ALL
      SELECT e->>'id' AS id, e->>'name' AS name, e->>'path' AS path, e->>'type' AS type
      FROM "TrashEntry" t
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.manifest) = 'array' THEN t.manifest ELSE '[]'::jsonb END) e
      WHERE t."spaceId" = ${spaceId}::uuid AND jsonb_typeof(e) = 'object' AND e->>'id' = ANY(${ids}::text[])`;
    const out = new Map<string, Pick<Item, 'id' | 'name' | 'type'>>();
    for (const r of rows) {
      if (out.has(r.id) || (r.type !== 'file' && r.type !== 'folder')) continue;
      const name = r.name ?? r.path?.split('/').pop() ?? '';
      out.set(r.id, { id: r.id, name, type: r.type });
    }
    return out;
  }

  /**
   * Active shares of the user (optionally of one item), newest first: shares of live items, and
   * shares of items in the trash (`itemTrashed`, so the owner can still revoke them; restoring the
   * item re-activates the link). Shares of items deleted for good are left out.
   */
  async list(user: IndexUser, rawItemId?: string): Promise<ShareLinkWire[]> {
    let itemId: string | undefined;
    if (rawItemId) {
      itemId = parseItemId(rawItemId) ?? undefined;
      if (!itemId) throw new SyncError('invalid_request', 'invalid itemId');
    }
    const shares = await this.prisma.shareLink.findMany({
      where: { ownerId: user.id, revokedAt: null, ...(itemId ? { itemId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return this.wires(shares, user, true);
  }

  /** Wire form of shares; shares of items deleted for good are left out. Items are looked up in each share's space. */
  private async wires(shares: ShareLink[], viewer: { id: string }, withUrl: boolean): Promise<ShareLinkWire[]> {
    const key = (spaceId: string, itemId: string) => `${spaceId}\u0000${itemId}`;
    const items = await this.prisma.item.findMany({
      where: { id: { in: [...new Set(shares.map((s) => s.itemId))] }, spaceId: { in: [...new Set(shares.map((s) => s.spaceId))] }, deletedAt: null },
    });
    const live = new Map(items.map((i) => [key(i.spaceId, i.id), i]));
    const missing = new Map<string, string[]>(); // spaceId -> item ids not live
    for (const s of shares) if (!live.has(key(s.spaceId, s.itemId))) missing.set(s.spaceId, [...new Set([...(missing.get(s.spaceId) ?? []), s.itemId])]);
    const trashed = new Map<string, Pick<Item, 'id' | 'name' | 'type'>>();
    for (const [spaceId, ids] of missing) for (const [id, t] of await this.trashedItems(spaceId, ids)) trashed.set(key(spaceId, id), t);
    const out: ShareLinkWire[] = [];
    for (const s of shares) {
      const item = live.get(key(s.spaceId, s.itemId));
      if (item) out.push(await this.toWire(s, item, viewer, false, withUrl));
      else {
        const t = trashed.get(key(s.spaceId, s.itemId));
        if (t) out.push(await this.toWire(s, t, viewer, true, withUrl));
      }
    }
    return out;
  }

  /**
   * Admin oversight across users, newest first. `status`: active = not revoked and not expired,
   * expired = not revoked but past expiry, all = additionally includes revoked shares.
   * The real link is only returned for the admin's own shares; others get `url: ''` (revoke, not reuse).
   */
  async listForAdmin(admin: IndexUser, filter: { userId?: string; spaceId?: string; status: 'active' | 'expired' | 'all' }): Promise<AdminShareWire[]> {
    const now = new Date();
    const shares = await this.prisma.shareLink.findMany({
      where: {
        ...(filter.userId ? { ownerId: filter.userId } : {}),
        ...(filter.spaceId ? { spaceId: filter.spaceId } : {}),
        ...(filter.status === 'all' ? {} : { revokedAt: null }),
        ...(filter.status === 'active' ? { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {}),
        ...(filter.status === 'expired' ? { expiresAt: { lte: now } } : {}),
      },
      include: { owner: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const byOwner = new Map<string, ShareLink[]>();
    for (const s of shares) byOwner.set(s.ownerId, [...(byOwner.get(s.ownerId) ?? []), s]);
    const wire = new Map<string, ShareLinkWire>();
    for (const [ownerId, list] of byOwner) for (const w of await this.wires(list, admin, ownerId === admin.id)) wire.set(w.id, w);
    const spaces = new Map((await this.prisma.space.findMany({
      where: { id: { in: [...new Set(shares.map((s) => s.spaceId))] } }, select: { id: true, name: true, kind: true },
    })).map((sp) => [sp.id, sp]));
    const out: AdminShareWire[] = [];
    for (const s of shares) {
      const w = wire.get(s.id);
      const sp = spaces.get(s.spaceId);
      if (w) out.push({ ...w, owner: s.owner, ...(sp ? { space: { id: sp.id, name: sp.name, kind: sp.kind === 'team' ? 'shared' : sp.kind } } : {}) });
    }
    return out;
  }

  /** Revokes any user's share (idempotent). */
  async revokeAny(id: string): Promise<void> {
    if (!UUID.test(id)) throw new SyncError('not_found');
    const share = await this.prisma.shareLink.findUnique({ where: { id } });
    if (!share) throw new SyncError('not_found');
    if (!share.revokedAt) await this.prisma.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  /** New token; the old one stops working immediately (its hash is gone). Unlock cookies die with the old path. */
  async rotate(user: IndexUser, id: string): Promise<ShareLinkWire> {
    const { share, item } = await this.ownShare(user, id);
    const token = newToken();
    const updated = await this.prisma.shareLink.update({
      where: { id: share.id },
      data: { tokenHash: hashToken(token), tokenEnc: await this.auth.sealToken(token, share.id) },
    });
    return this.toWire(updated, item, user);
  }

  async patch(user: IndexUser, id: string, patch: SharePatch): Promise<ShareLinkWire> {
    const { share, item } = await this.ownShare(user, id);
    SharesService.checkUpload(item, patch.allowUpload);
    const data: Partial<Pick<ShareLink, 'passwordHash' | 'expiresAt' | 'allowDownload' | 'allowUpload'>> = {};
    if (patch.password !== undefined) data.passwordHash = patch.password === null ? null : await SharesService.hashPassword(patch.password);
    if (patch.expiresAt !== undefined) data.expiresAt = futureDate(patch.expiresAt) ?? null;
    if (patch.allowDownload !== undefined) data.allowDownload = patch.allowDownload;
    if (patch.allowUpload !== undefined) data.allowUpload = patch.allowUpload;
    const updated = await this.prisma.shareLink.update({ where: { id: share.id }, data });
    return this.toWire(updated, item, user);
  }

  async revoke(user: IndexUser, id: string): Promise<void> {
    if (!UUID.test(id)) throw new SyncError('not_found');
    const share = await this.prisma.shareLink.findFirst({ where: { id, ownerId: user.id } });
    if (!share) throw new SyncError('not_found');
    if (!share.revokedAt) await this.prisma.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  // ---------------------------------------------------------------- public API

  async info(rs: ResolvedShare): Promise<PublicShareInfo> {
    const { share, root } = rs;
    let size = Number(root.size);
    if (root.type === 'folder') {
      const [row] = await this.prisma.$queryRaw<{ total: bigint | null }[]>`
        SELECT SUM(size)::bigint AS total FROM "Item"
        WHERE "spaceId" = ${share.spaceId}::uuid AND "deletedAt" IS NULL AND type = 'file'
        AND left(path, char_length(${root.path}) + 1) = ${root.path} || '/'`;
      size = Number(row?.total ?? 0n);
    }
    await this.prisma.shareLink.update({ where: { id: share.id }, data: { hits: { increment: 1 } } });
    return {
      id: toSyncId(root), name: root.name, type: root.type, size, mime: root.type === 'file' ? mimeFor(root.name) : null,
      ownerDisplayName: rs.owner.displayName, allowDownload: share.allowDownload,
      allowUpload: share.allowUpload && root.type === 'folder', expiresAt: share.expiresAt?.toISOString() ?? null,
    };
  }

  /** Verifies the password of an active share; true if it has none. */
  async checkPassword(share: ShareLink, password: string): Promise<boolean> {
    if (!share.passwordHash) return true;
    return argon2.verify(share.passwordHash, password).catch(() => false);
  }

  private async thumbShas(items: Item[]): Promise<Set<string>> {
    const shas = [...new Set(items.map((i) => i.contentHash).filter((s): s is string => !!s))];
    if (!shas.length) return new Set();
    const jobs = await this.prisma.derivativeJob.findMany({ where: { sha: { in: shas }, kind: 'thumb', status: 'done' }, select: { sha: true } });
    return new Set(jobs.map((j) => j.sha));
  }

  /** `thumbs`: content hashes with a thumbnail, and ids of folders with a mosaic of their children. */
  private entry(i: Item, name: string, thumbs: Set<string>): PublicShareEntry {
    const isFile = i.type === 'file';
    return {
      id: toSyncId(i), name, type: i.type, size: isFile ? Number(i.size) : 0, mime: isFile ? mimeFor(i.name) : null,
      modifiedAt: i.mtime.toISOString(), hasThumbnail: isFile ? !!i.contentHash && thumbs.has(i.contentHash) : thumbs.has(i.id),
    };
  }

  /** Children of a folder inside the share: folders first, then by name. */
  async children(rs: ResolvedShare, rawFolder: string | undefined): Promise<PublicShareEntry[]> {
    if (rs.root.type !== 'folder') throw new SyncError('invalid_request', 'not a folder share');
    const folder = await this.auth.target(rs, rawFolder, 'folder');
    await this.auth.realPathOf(rs, folder); // a folder replaced by a symlink on disk is not browsable
    const rows = await this.prisma.item.findMany({ where: { spaceId: rs.share.spaceId, parentId: folder.id, deletedAt: null } });
    const names = assignDisplayNames(rows);
    const thumbs = await this.thumbShas(rows);
    // Subfolders are inside the share, and so are their children (the mosaic's pictures).
    const folders = await chooseFolderThumbs(this.prisma, rs.share.spaceId, rows.filter((r) => r.type === 'folder').map((r) => r.id));
    for (const id of folders.keys()) thumbs.add(id);
    return rows
      .map((r) => this.entry(r, names.get(r.id) ?? r.name, thumbs))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  }

  /** Real path of an in-scope file, opened through FilesService (share's space, live, realpath in the space root). */
  async fileForRead(rs: ResolvedShare, item: Item): Promise<{ item: Item; abs: string }> {
    const { item: row, abs } = await this.files.openRead(rs.space, item.id);
    const inside = await this.auth.realPathOf(rs, row);
    if (inside !== abs) throw new SyncError('not_found');
    return { item: row, abs };
  }

  /**
   * Thumbnail file path if the worker has produced one for the item's current content; for a
   * folder in the share, the mosaic of its children's thumbnails (folder-thumbnails.ts).
   */
  async thumbnail(rs: ResolvedShare, rawItem: string, size: 256 | 1024): Promise<{ path: string }> {
    const item = await this.auth.target(rs, rawItem);
    if (item.type === 'folder') {
      await this.auth.realPathOf(rs, item); // like browsing it: not through a symlinked folder
      const mosaic = await this.folderThumbs.thumbnail(rs.share.spaceId, item.id, size);
      if (!mosaic) throw new SyncError('not_found');
      return { path: mosaic.path };
    }
    const sha = item.contentHash;
    if (!sha) throw new SyncError('not_found');
    const job = await this.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha, kind: 'thumb' } } });
    if (job?.status !== 'done') throw new SyncError('not_found');
    const file = this.derived.pathFor(sha, 'thumb', size);
    if (!(await this.derived.has(file))) {
      await this.gc.requeueThumb(sha); // derived files lost: regenerate
      throw new SyncError('not_found');
    }
    return { path: file };
  }

  /** Entries of a ZIP of `folder` (in scope): all live descendants in path order, names relative to it. */
  async zipEntries(rs: ResolvedShare, folder: Item): Promise<ZipEntrySource[]> {
    const realRoot = await this.auth.realRoot(rs);
    await this.auth.realPathOf(rs, folder, realRoot);
    const rows = (await this.store.liveDescendants(this.prisma, rs.share.spaceId, folder.path))
      .filter((r) => ShareAuth.inScope(rs, r)) // re-checked per row, defense in depth
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const base = folder.path.length + 1;
    return rows.map((r) => ({
      name: zipEntryName(r.path.slice(base)), type: r.type, mtime: r.mtime,
      open: r.type === 'file'
        ? async (): Promise<Readable | null> => {
          const real = await this.auth.realPathOf(rs, r, realRoot);
          const fh = await openNoFollow(real);
          return fh.createReadStream();
        }
        : undefined,
    }));
  }

  /** External upload into a folder of an upload-enabled folder share; never overwrites. */
  async upload(rs: ResolvedShare, folder: Item, name: string, body: Readable): Promise<PublicShareEntry> {
    const row = await this.files.upload(rs.space, folder.id, name, body, { onConflict: 'rename' });
    return this.entry(row, row.name, new Set());
  }

  /** Permission + scope checks of an upload, before the body is read. */
  async uploadTarget(rs: ResolvedShare, rawFolder: string | undefined): Promise<Item> {
    if (!rs.share.allowUpload || rs.root.type !== 'folder') throw new SyncError('upload_not_allowed');
    const folder = await this.auth.target(rs, rawFolder, 'folder');
    await this.auth.realPathOf(rs, folder);
    return folder;
  }
}

