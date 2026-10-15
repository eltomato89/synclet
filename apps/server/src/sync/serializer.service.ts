import { Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SyncItem } from '@synclet/shared';
import { lookup } from 'mime-types';
import { createHash } from 'node:crypto';
import { assignDisplayNames } from '../common/names';
import { codeLanguage, previewKind } from '../derivatives/preview-kind';
import type { IndexUser } from '../common/types';
import { itemEtag } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { ROOT_ID, toSyncId } from './sync-ids';

const CAPS = { read: true as const, write: true, rename: true, move: true, delete: true, addChildren: true };

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
  constructor(private readonly prisma: PrismaService) {}

  rootItem(user: IndexUser): SyncItem {
    const epoch = new Date(0).toISOString();
    return {
      id: ROOT_ID, parentId: null, type: 'folder', kind: 'root', name: user.username, size: 0, mime: null, version: null,
      sha256: null, etag: 't0', contentEtag: null, createdAt: epoch, modifiedAt: epoch, documentId: null,
      capabilities: { ...CAPS, rename: false, move: false, delete: false },
    };
  }

  /** Serializes rows; display names are computed against all live siblings of each parent. */
  async toSyncItems(user: IndexUser, rows: Item[]): Promise<SyncItem[]> {
    const parents = [...new Set(rows.map((r) => r.parentId))];
    const display = new Map<string, string>();
    for (const parentId of parents) {
      const sibs = await this.prisma.item.findMany({
        where: { ownerId: user.id, parentId, deletedAt: null },
        select: { id: true, name: true, type: true, createdAt: true },
      });
      for (const [id, name] of assignDisplayNames(sibs)) display.set(id, name);
    }
    // One query per page: which content hashes have a finished thumbnail.
    const shas = [...new Set(rows.flatMap((r) => (r.type === 'file' && r.contentHash ? [r.contentHash] : [])))];
    const thumbs = new Set(shas.length
      ? (await this.prisma.derivativeJob.findMany({ where: { sha: { in: shas }, kind: 'thumb', status: 'done' }, select: { sha: true } })).map((j) => j.sha)
      : []);
    return rows.map((r) => this.one(r, display.get(r.id) ?? r.name, r.contentHash !== null && thumbs.has(r.contentHash)));
  }

  private one(r: Item, name: string, thumbnail: boolean): SyncItem {
    const isFile = r.type === 'file';
    const mime = isFile ? mimeFor(r.name) : null;
    const language = isFile ? codeLanguage(r.name) : undefined;
    const kind = previewKind(r.name, mime);
    return {
      id: toSyncId(r),
      parentId: r.parentId ? `d_${r.parentId}` : ROOT_ID,
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
      capabilities: { ...CAPS, addChildren: !isFile },
      ...(isFile ? { preview: { kind, thumbnail, ...(kind === 'code' && language ? { language } : {}) } } : {}),
    };
  }
}
