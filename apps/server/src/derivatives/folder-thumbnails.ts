import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { utimes } from 'node:fs/promises';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { DerivativesGc } from './derivatives-gc';
import { DerivedStore } from './derived-store';

/**
 * Folder thumbnails
 * =================
 * A folder's thumbnail is a mosaic of the thumbnails of up to four of its direct children (most
 * recently modified first, one per distinct content). Nothing is stored per folder: the children
 * are chosen when the folder is serialized or its thumbnail is requested, and the mosaic is
 * cached in the derived store under a key hashed from the chosen content hashes – any change of
 * the set (a child added, removed, replaced, or its thumbnail finished) yields a new key, so
 * invalidation is implicit. Mosaics are composed lazily on the first request from the children's
 * existing thumbnails (cheap: no source file is decoded) and removed by the maintenance GC when
 * they were not served for a while.
 */

export const FOLDER_THUMB_MAX = 4;
/** Output size per requested thumbnail size: landscape 4:3, the shape of the web's grid tiles. */
export const FOLDER_THUMB_DIMS: Record<256 | 1024, { width: number; height: number; gap: number }> = {
  256: { width: 256, height: 192, gap: 3 },
  1024: { width: 1024, height: 768, gap: 12 },
};
const QUALITY = 78;
/** A served mosaic's mtime is refreshed at most this often (it is what the GC goes by). */
const TOUCH_AFTER_MS = 24 * 3600_000;
/** Mosaics composed at the same time at most (a grid view requests many at once). */
const MAX_CONCURRENT = 2;
const SHARP_INPUT = { limitInputPixels: 100_000_000, failOn: 'error' as const };

export interface FolderThumbChoice {
  /** Cache key of the mosaic (hex sha256 of the chosen content hashes, in order). */
  key: string;
  /** Content hashes of the chosen children, most recently modified first (1..4). */
  shas: string[];
}

export interface Cell { left: number; top: number; width: number; height: number }

/** Cache key for a choice of children: changes whenever the set or the order changes. */
export function folderThumbKey(shas: string[]): string {
  return createHash('sha256').update(`folder-thumb-v1\n${shas.join('\n')}`).digest('hex');
}

/**
 * Cells of the mosaic for `n` (1..4) pictures: 1 = the whole tile, 2 = side by side,
 * 3 = one large on the left and two stacked on the right, 4 = a 2×2 grid. Separated by `gap`
 * transparent pixels.
 */
export function mosaicCells(n: number, width: number, height: number, gap: number): Cell[] {
  const lw = Math.floor((width - gap) / 2);
  const rw = width - lw - gap;
  const th = Math.floor((height - gap) / 2);
  const bh = height - th - gap;
  const left = { left: 0, width: lw };
  const right = { left: lw + gap, width: rw };
  const full = { top: 0, height };
  const top = { top: 0, height: th };
  const bottom = { top: th + gap, height: bh };
  switch (Math.min(Math.max(n, 0), FOLDER_THUMB_MAX)) {
    case 0: return [];
    case 1: return [{ left: 0, width, ...full }];
    case 2: return [{ ...left, ...full }, { ...right, ...full }];
    case 3: return [{ ...left, ...full }, { ...right, ...top }, { ...right, ...bottom }];
    default: return [{ ...left, ...top }, { ...right, ...top }, { ...left, ...bottom }, { ...right, ...bottom }];
  }
}

/**
 * The children each folder's thumbnail is made of: up to four live direct children of the same
 * space with a finished thumbnail, one per distinct content, most recently modified first.
 * Folders without any are missing from the map. One query for all `folderIds`.
 */
export async function chooseFolderThumbs(prisma: PrismaService, spaceId: string, folderIds: string[]): Promise<Map<string, FolderThumbChoice>> {
  const out = new Map<string, FolderThumbChoice>();
  if (!folderIds.length) return out;
  const rows = await prisma.$queryRaw<{ folderId: string; sha: string }[]>`
    SELECT f.id::text AS "folderId", c.sha
    FROM unnest(${folderIds}::uuid[]) AS f(id)
    CROSS JOIN LATERAL (
      SELECT d.sha, row_number() OVER (ORDER BY d.mtime DESC, d.id) AS n
      FROM (
        SELECT DISTINCT ON (i."contentHash") i."contentHash" AS sha, i.mtime, i.id
        FROM "Item" i
        JOIN "DerivativeJob" j ON j.sha = i."contentHash" AND j.kind = 'thumb' AND j.status = 'done'
        WHERE i."spaceId" = ${spaceId}::uuid AND i."parentId" = f.id AND i."deletedAt" IS NULL AND i.type = 'file'
        ORDER BY i."contentHash", i.mtime DESC, i.id
      ) d
      ORDER BY d.mtime DESC, d.id
      LIMIT ${Prisma.raw(String(FOLDER_THUMB_MAX))}
    ) c
    ORDER BY f.id, c.n`;
  const shas = new Map<string, string[]>();
  for (const r of rows) {
    const list = shas.get(r.folderId) ?? [];
    list.push(r.sha);
    shas.set(r.folderId, list);
  }
  for (const [id, list] of shas) out.set(id, { key: folderThumbKey(list), shas: list });
  return out;
}

/** Composes, caches and serves folder mosaics (server side, on request). */
@Injectable()
export class FolderThumbnails {
  private readonly log = new Logger(FolderThumbnails.name);
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DerivedStore,
    private readonly gc: DerivativesGc,
  ) {}

  /**
   * The mosaic of folder `folderId` (in `spaceId`) at `size`: its file and cache key, or null when
   * no child has a thumbnail (or a child's thumbnail file is missing; it is then requeued).
   * The caller has checked read access to the folder; its children share its space.
   */
  async thumbnail(spaceId: string, folderId: string, size: 256 | 1024): Promise<{ path: string; key: string } | null> {
    const choice = (await chooseFolderThumbs(this.prisma, spaceId, [folderId])).get(folderId);
    if (!choice) return null;
    const file = this.store.folderThumbPath(choice.key, size);
    const id = `${choice.key}-${size}`;
    let pending = this.inFlight.get(id);
    if (!pending) {
      pending = this.ensure(file, choice, size).finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, pending);
    }
    const path = await pending;
    return path ? { path, key: choice.key } : null;
  }

  private async ensure(file: string, choice: FolderThumbChoice, size: 256 | 1024): Promise<string | null> {
    const mtime = await this.store.mtimeOf(file);
    if (mtime !== null) {
      if (Date.now() - mtime > TOUCH_AFTER_MS) {
        const now = new Date();
        await utimes(file, now, now).catch(() => undefined);
      }
      return file;
    }
    const sources: string[] = [];
    for (const sha of choice.shas) {
      const src = this.store.pathFor(sha, 'thumb', 1024);
      if (!(await this.store.has(src))) {
        await this.gc.requeueThumb(sha); // derived files lost: regenerate, then the mosaic
        return null;
      }
      sources.push(src);
    }
    let data: Buffer;
    try {
      data = await this.limited(() => composeMosaic(sources, size));
    } catch (e) {
      // A child's thumbnail could not be decoded: no mosaic (the folder keeps its icon).
      this.log.warn(`folder thumbnail ${choice.key.slice(0, 12)} failed: ${(e as Error).message}`);
      return null;
    }
    await this.store.writeAtomic(file, data);
    return file;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < MAX_CONCURRENT) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }
}

/** A webp mosaic of the given thumbnail files (1..4, in cell order), each cropped to its cell. */
export async function composeMosaic(sources: string[], size: 256 | 1024): Promise<Buffer> {
  const { width, height, gap } = FOLDER_THUMB_DIMS[size];
  const cells = mosaicCells(sources.length, width, height, gap);
  const layers = await Promise.all(cells.map(async (c, i) => ({
    input: await sharp(sources[i], SHARP_INPUT).resize({ width: c.width, height: c.height, fit: 'cover' }).toBuffer(),
    left: c.left,
    top: c.top,
  })));
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers).webp({ quality: QUALITY }).toBuffer();
}
