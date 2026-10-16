import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { absPath, realpathInside } from '../common/paths';
import { PrismaService } from '../prisma/prisma.service';

/** Bytes hashed per call at most (a single larger file is still hashed in full). */
const BYTES_PER_LOOP = 1024 ** 3;
/** Files that could not be read are skipped for this long before they are tried again. */
const RETRY_AFTER_MS = 15 * 60_000;
export const MAX_SKIPPED = 10_000;

/**
 * Computes `contentHash` for files the indexer recorded without one (host edits, external
 * copies). Ruling 1b-1: no version bump, no journal entry — clients see the hash on the next
 * fetch. The hash is stored only if size, mtime and inode are still what was hashed.
 */
@Injectable()
export class HashBackfill {
  private readonly log = new Logger(HashBackfill.name);
  /** id → time of the last failed attempt (unreadable / changed files). */
  private readonly skipped = new Map<string, number>();
  maxSkipped = MAX_SKIPPED;
  /** Test seam: runs after a file was hashed, before the row is updated. */
  afterHash?: (item: Item) => Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Returns the number of rows that received a hash. `shouldStop` is checked between files. */
  async hashMissing(limit = 200, shouldStop: () => boolean = () => false): Promise<number> {
    const now = Date.now();
    for (const [id, at] of this.skipped) if (now - at > RETRY_AFTER_MS) this.skipped.delete(id);
    const rows = await this.prisma.item.findMany({
      where: { type: 'file', deletedAt: null, contentHash: null, ...(this.skipped.size ? { id: { notIn: [...this.skipped.keys()] } } : {}) },
      include: { space: { select: { rootPath: true } } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    let hashed = 0;
    let budget = BYTES_PER_LOOP;
    for (const row of rows) {
      if (budget <= 0 || shouldStop()) break;
      budget -= Number(row.size);
      const ok = await this.hashOne(row, row.space.rootPath).catch((e) => {
        this.log.debug(`cannot hash ${row.id}: ${(e as Error).message}`);
        return false;
      });
      if (ok) hashed++;
      else this.skip(row.id);
    }
    return hashed;
  }

  /** Records a failed attempt; when full, the oldest entry is evicted (Map keeps insertion order). */
  private skip(id: string) {
    this.skipped.delete(id);
    if (this.skipped.size >= this.maxSkipped) this.skipped.delete(this.skipped.keys().next().value!);
    this.skipped.set(id, Date.now());
  }

  /** Number of files currently skipped (tests). */
  get skippedCount(): number { return this.skipped.size; }

  private async hashOne(row: Item, root: string): Promise<boolean> {
    const abs = await realpathInside(absPath(root, row.path), root);
    const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    let sha: string;
    try {
      const before = await fh.stat({ bigint: true });
      if (!before.isFile() || !this.matches(row, before)) return false; // not indexed yet: the indexer resets the row first
      const hash = createHash('sha256');
      for await (const chunk of fh.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
      sha = hash.digest('hex');
      const after = await fh.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false; // written while hashing
    } finally {
      await fh.close();
    }
    await this.afterHash?.(row);
    // Optimistic: the indexer may have recorded a change meanwhile (it resets contentHash and bumps the version).
    // Raw SQL so "updatedAt" stays untouched: nothing a client or the move pairing looks at changes.
    const count = await this.prisma.$executeRaw`
      UPDATE "Item" SET "contentHash" = ${sha}
      WHERE id = ${row.id}::uuid AND "deletedAt" IS NULL AND "contentHash" IS NULL AND size = ${row.size}
        AND mtime = ${row.mtime} AND ino IS NOT DISTINCT FROM ${row.ino} AND version = ${row.version}`;
    return count === 1;
  }

  private matches(row: Item, st: { size: bigint; mtimeMs: bigint; ino: bigint }): boolean {
    return st.size === row.size && new Date(Number(st.mtimeMs)).getTime() === row.mtime.getTime() && (row.ino === null || st.ino === row.ino);
  }
}
