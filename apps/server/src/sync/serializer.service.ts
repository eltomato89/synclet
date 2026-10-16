import { Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SyncItem } from '@synclet/shared';
import { lookup } from 'mime-types';
import { createHash } from 'node:crypto';
import { assignDisplayNames } from '../common/names';
import { chooseFolderThumbs } from '../derivatives/folder-thumbnails';
import { codeLanguage, previewKind } from '../derivatives/preview-kind';
import type { IndexUser } from '../common/types';
import { itemEtag } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpaceAccess, type Role } from '../spaces/space-access.service';
import { apiSpaceId, PERSONAL_API_ID } from '../spaces/space-ids';
import { ROOT_ID, spaceRootId, toSyncId } from './sync-ids';

const CAPS = { read: true as const, write: true, rename: true, move: true, delete: true, addChildren: true };
const READ_ONLY_CAPS = { read: true as const, write: false, rename: false, move: false, delete: false, addChildren: false };

/** How the caller sees the space of the serialized rows: its API id and the caller's role. */
export interface ItemView {
  /** `personal` for the caller's own personal space, else the space uuid. */
  apiSpaceId: string;
  role: Role;
}

export function mimeFor(name: string): string {
  return lookup(name) || 'application/octet-stream';
}

/**
 * Folder etag as seen by sync clients. It is derived only from what a client can observe
 * about the folder itself (parent, display name, modifiedAt) – never from `updatedAt`, which
 * `ItemStore.rewritePrefix` bumps on every descendant when an ancestor is moved (without a
 * journal entry, so clients would never learn the new value and get spurious 412s).
 */
export function folderEtag(row: Pick<Item, 'parentId' | 'mtime'>, displayName: string): string {
  const h = createHash('sha256').update(`${row.parentId ?? ''}\u0000${displayName}\u0000${row.mtime.getTime()}`).digest('hex');
  return `t${h.slice(0, 16)}`;
}

@Injectable()
export class SerializerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SpaceAccess,
  ) {}

  /** The caller's personal root (`root`). */
  rootItem(user: IndexUser): SyncItem {
    const epoch = new Date(0).toISOString();
    return {
      id: ROOT_ID, parentId: null, type: 'folder', kind: 'root', name: user.username, size: 0, mime: null, version: null,
      sha256: null, etag: 't0', contentEtag: null, createdAt: epoch, modifiedAt: epoch, documentId: null,
      capabilities: { ...CAPS, rename: false, move: false, delete: false },
      spaceId: PERSONAL_API_ID,
    };
  }

  /** The virtual root `r_<uuid>` of a team/external space: never renamed, moved or deleted; children only with write. */
  spaceRootItem(space: { id: string; name: string; createdAt?: Date }, role: Role): SyncItem {
    const at = (space.createdAt ?? new Date(0)).toISOString();
    const etag = `t${createHash('sha256').update(`root\u0000${space.name}`).digest('hex').slice(0, 16)}`;
    return {
      id: spaceRootId(space.id), parentId: null, type: 'folder', kind: 'root', name: space.name, size: 0, mime: null, version: null,
      sha256: null, etag, contentEtag: null, createdAt: at, modifiedAt: at, documentId: null,
      capabilities: { ...READ_ONLY_CAPS, addChildren: role === 'write' },
      spaceId: space.id,
    };
  }

  /**
   * The view of `user` on `spaceId` (API id and role), for callers without one at hand (error
   * bodies, tus). Without access the items are shown read-only.
   */
  async viewFor(user: { id: string }, spaceId: string): Promise<ItemView> {
    if (spaceId === user.id) return { apiSpaceId: PERSONAL_API_ID, role: 'write' };
    const row = await this.prisma.space.findUnique({ where: { id: spaceId } });
    const role = row ? await this.access.roleFor(user, row) : null;
    return { apiSpaceId: apiSpaceId({ id: spaceId }, user), role: role ?? 'read' };
  }

  /** Root id of `space` as parentId of its top-level items: `root` for personal spaces, else `r_<uuid>`. */
  private async rootIdOf(space: { id: string; kind?: string }, view?: ItemView): Promise<string> {
    if (view) return view.apiSpaceId === PERSONAL_API_ID ? ROOT_ID : spaceRootId(space.id);
    const kind = space.kind ?? (await this.prisma.space.findUnique({ where: { id: space.id }, select: { kind: true } }))?.kind ?? 'personal';
    return kind === 'personal' ? ROOT_ID : spaceRootId(space.id);
  }

  /**
   * Serializes rows of `space`; display names are computed against all live siblings of each parent.
   * With `view`, items carry `spaceId` and capabilities follow the role (read → read-only).
   */
  async toSyncItems(space: { id: string; kind?: string }, rows: Item[], view?: ItemView): Promise<SyncItem[]> {
    if (rows.length === 0) return [];
    const rootId = await this.rootIdOf(space, view);
    const parents = [...new Set(rows.map((r) => r.parentId))];
    const display = new Map<string, string>();
    for (const parentId of parents) {
      const sibs = await this.prisma.item.findMany({
        where: { spaceId: space.id, parentId, deletedAt: null },
        select: { id: true, name: true, type: true, createdAt: true },
      });
      for (const [id, name] of assignDisplayNames(sibs)) display.set(id, name);
    }
    // One query per page: which content hashes have a finished thumbnail.
    const shas = [...new Set(rows.flatMap((r) => (r.type === 'file' && r.contentHash ? [r.contentHash] : [])))];
    const thumbs = new Set(shas.length
      ? (await this.prisma.derivativeJob.findMany({ where: { sha: { in: shas }, kind: 'thumb', status: 'done' }, select: { sha: true } })).map((j) => j.sha)
      : []);
    // And which folders have a mosaic of their children's thumbnails (folder-thumbnails.ts).
    const folderThumbs = await chooseFolderThumbs(this.prisma, space.id, rows.filter((r) => r.type === 'folder').map((r) => r.id));
    return rows.map((r) => this.one(r, display.get(r.id) ?? r.name, r.contentHash !== null && thumbs.has(r.contentHash), rootId, view, folderThumbs.get(r.id)?.key));
  }

  private one(r: Item, name: string, thumbnail: boolean, rootId: string, view?: ItemView, folderThumbKey?: string): SyncItem {
    const isFile = r.type === 'file';
    const mime = isFile ? mimeFor(r.name) : null;
    const language = isFile ? codeLanguage(r.name) : undefined;
    const kind = previewKind(r.name, mime);
    return {
      id: toSyncId(r),
      parentId: r.parentId ? `d_${r.parentId}` : rootId,
      type: r.type, kind: r.type, name,
      size: isFile ? Number(r.size) : 0,
      mime,
      version: isFile ? r.version : null,
      sha256: isFile ? r.contentHash : null,
      etag: isFile ? itemEtag(r) : folderEtag(r, name),
      contentEtag: isFile ? `v${r.version}` : null,
      createdAt: r.createdAt.toISOString(),
      modifiedAt: r.mtime.toISOString(),
      documentId: isFile ? toSyncId(r) : null,
      capabilities: view?.role === 'read' ? READ_ONLY_CAPS : { ...CAPS, addChildren: !isFile },
      ...(isFile ? { preview: { kind, thumbnail, ...(kind === 'code' && language ? { language } : {}) } } : {}),
      // Folders: only when a mosaic exists (GET thumbnail?composite=1); the key changes with it.
      ...(!isFile && folderThumbKey ? { preview: { kind: 'none' as const, thumbnail: true, thumbnailKey: folderThumbKey } } : {}),
      ...(view ? { spaceId: view.apiSpaceId } : {}),
    };
  }
}
