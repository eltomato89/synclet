import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item, ShareLink } from '@prisma/client';
import type { CreateShareInput, PublicShareEntry, PublicShareInfo, ShareLinkWire } from '@synclet/shared';
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
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { PrismaService } from '../prisma/prisma.service';
import { openNoFollow } from '../sync/http-content';
import { mimeFor } from '../sync/serializer.service';
import { toSyncId, UUID } from '../sync/sync-ids';
import { decryptToken, encryptToken, parseItemId, ResolvedShare, ShareAuth } from './share-auth';
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
    private readonly auth: ShareAuth,
    private readonly files: FilesService,
    private readonly store: ItemStore,
    private readonly derived: DerivedStore,
    private readonly gc: DerivativesGc,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- owner API

  private async toWire(share: ShareLink, item: Item): Promise<ShareLinkWire> {
    let url = '';
    try {
      url = this.auth.url(decryptToken(await this.auth.tokenKey(), share.tokenEnc, share.id));
    } catch (e) {
      // Only if the server secret changed: the link still works, but the owner must rotate to copy it.
      this.log.error(`cannot decrypt token of share ${share.id}: ${(e as Error).message}`);
    }
    return {
      id: share.id, itemId: toSyncId(item), itemName: item.name, itemType: item.type, url,
      hasPassword: share.passwordHash !== null, expiresAt: share.expiresAt?.toISOString() ?? null,
      allowDownload: share.allowDownload, allowUpload: share.allowUpload,
      createdAt: share.createdAt.toISOString(), revokedAt: share.revokedAt?.toISOString() ?? null, hits: share.hits,
    };
  }

  private async liveItem(user: IndexUser, id: string): Promise<Item> {
    const item = await this.prisma.item.findFirst({ where: { id, ownerId: user.id, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    return item;
  }

  /** An active (not revoked) share of `user` with its live item; anything else is 404. */
  private async ownShare(user: IndexUser, id: string): Promise<{ share: ShareLink; item: Item }> {
    if (!UUID.test(id)) throw new SyncError('not_found');
    const share = await this.prisma.shareLink.findFirst({ where: { id, ownerId: user.id, revokedAt: null } });
    if (!share) throw new SyncError('not_found');
    return { share, item: await this.liveItem(user, share.itemId) };
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
    const item = await this.liveItem(user, itemId);
    SharesService.checkUpload(item, input.allowUpload);
    const id = randomUUID();
    const token = newToken();
    const share = await this.prisma.shareLink.create({
      data: {
        id, ownerId: user.id, itemId: item.id, tokenHash: hashToken(token), tokenEnc: encryptToken(await this.auth.tokenKey(), token, id),
        passwordHash: input.password ? await SharesService.hashPassword(input.password) : null,
        expiresAt: futureDate(input.expiresAt) ?? null,
        allowDownload: input.allowDownload ?? true, allowUpload: input.allowUpload ?? false,
      },
    });
    return this.toWire(share, item);
  }

  /** Active shares of the user (optionally of one item) whose item is live, newest first. */
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
    const items = await this.prisma.item.findMany({ where: { id: { in: [...new Set(shares.map((s) => s.itemId))] }, ownerId: user.id, deletedAt: null } });
    const byId = new Map(items.map((i) => [i.id, i]));
    const out: ShareLinkWire[] = [];
    for (const s of shares) {
      const item = byId.get(s.itemId);
      if (item) out.push(await this.toWire(s, item));
    }
    return out;
  }

  /** New token; the old one stops working immediately (its hash is gone). Unlock cookies die with the old path. */
  async rotate(user: IndexUser, id: string): Promise<ShareLinkWire> {
    const { share, item } = await this.ownShare(user, id);
    const token = newToken();
    const updated = await this.prisma.shareLink.update({
      where: { id: share.id },
      data: { tokenHash: hashToken(token), tokenEnc: encryptToken(await this.auth.tokenKey(), token, share.id) },
    });
    return this.toWire(updated, item);
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
    return this.toWire(updated, item);
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
        WHERE "ownerId" = ${share.ownerId}::uuid AND "deletedAt" IS NULL AND type = 'file'
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

  private entry(i: Item, name: string, thumbs: Set<string>): PublicShareEntry {
    const isFile = i.type === 'file';
    return {
      id: toSyncId(i), name, type: i.type, size: isFile ? Number(i.size) : 0, mime: isFile ? mimeFor(i.name) : null,
      modifiedAt: i.mtime.toISOString(), hasThumbnail: isFile && !!i.contentHash && thumbs.has(i.contentHash),
    };
  }

  /** Children of a folder inside the share: folders first, then by name. */
  async children(rs: ResolvedShare, rawFolder: string | undefined): Promise<PublicShareEntry[]> {
    if (rs.root.type !== 'folder') throw new SyncError('invalid_request', 'not a folder share');
    const folder = await this.auth.target(rs, rawFolder, 'folder');
    await this.auth.realPathOf(rs, folder); // a folder replaced by a symlink on disk is not browsable
    const rows = await this.prisma.item.findMany({ where: { ownerId: rs.share.ownerId, parentId: folder.id, deletedAt: null } });
    const names = assignDisplayNames(rows);
    const thumbs = await this.thumbShas(rows);
    return rows
      .map((r) => this.entry(r, names.get(r.id) ?? r.name, thumbs))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  }

  /** Real path of an in-scope file, opened through FilesService (owner, live, realpath in the user root). */
  async fileForRead(rs: ResolvedShare, item: Item): Promise<{ item: Item; abs: string }> {
    const { item: row, abs } = await this.files.openRead(rs.owner, item.id);
    const inside = await this.auth.realPathOf(rs, row);
    if (inside !== abs) throw new SyncError('not_found');
    return { item: row, abs };
  }

  /** Thumbnail file path if the worker has produced one for the item's current content. */
  async thumbnail(rs: ResolvedShare, rawItem: string, size: 256 | 1024): Promise<{ path: string; sha: string }> {
    const item = await this.auth.target(rs, rawItem, 'file');
    const sha = item.contentHash;
    if (!sha) throw new SyncError('not_found');
    const job = await this.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha, kind: 'thumb' } } });
    if (job?.status !== 'done') throw new SyncError('not_found');
    const file = this.derived.pathFor(sha, 'thumb', size);
    if (!(await this.derived.has(file))) {
      await this.gc.requeueThumb(sha); // derived files lost: regenerate
      throw new SyncError('not_found');
    }
    return { path: file, sha };
  }

  /** Entries of a ZIP of `folder` (in scope): all live descendants in path order, names relative to it. */
  async zipEntries(rs: ResolvedShare, folder: Item): Promise<ZipEntrySource[]> {
    const realRoot = await this.auth.realRoot(rs);
    await this.auth.realPathOf(rs, folder, realRoot);
    const rows = (await this.store.liveDescendants(this.prisma, rs.share.ownerId, folder.path))
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
    const row = await this.files.upload(rs.owner, folder.id, name, body, { onConflict: 'rename' });
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

