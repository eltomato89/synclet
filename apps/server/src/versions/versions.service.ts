import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FileVersion, Item, VersionSource } from '@prisma/client';
import type { VersionWire } from '@synclet/shared';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { splitExt } from '../common/names';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { NO_HARDLINK } from '../files/fs-ops';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { UUID } from '../sync/sync-ids';
import { selectVersionsToKeep } from './retention';

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const exists = (p: string) => lstat(p).then(() => true, (e) => (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR' ? false : Promise.reject(e)));
/** Temp files of an interrupted cross-file-system capture, directly in `<meta>/versions`. */
const TMP_PREFIX = '.tmp-';
/** Unreferenced files in the version store are only swept when older than this (ctime). */
const STRAY_AGE_MS = 3600 * 1000;
const CHUNK = 1000;

/**
 * Replaces a file's content from a stream through FilesService's atomic replace path (with a
 * version capture of the current content). Registered by FilesService, which itself depends on
 * VersionsService – this keeps the provider graph acyclic.
 */
export interface VersionContentReplacer {
  restoreFromVersion(user: IndexUser, itemId: string, body: Readable): Promise<Item>;
}

export interface OpenedVersion { item: Item; version: FileVersion; abs: string; downloadName: string }

/** `<base> (v<n>).<ext>` */
export function versionDownloadName(name: string, version: number): string {
  const { base, ext } = splitExt(name);
  return `${base} (v${version})${ext}`;
}

async function sha256File(abs: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/**
 * File versions (only with `SYNCLET_VERSIONS=on`): the content a server-side overwrite replaces is
 * kept under `<meta>/versions/<ownerId>/<itemId>/<version>-<sha|nohash>`, never in the user folder.
 * Versions follow the item id (moves/renames need nothing), stay while the item is in the trash and
 * are removed with it (delete forever, empty, expiry) or when the item row is gone for good.
 */
@Injectable()
export class VersionsService {
  private readonly log = new Logger(VersionsService.name);
  private replacer: VersionContentReplacer | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get enabled(): boolean { return this.config.versions; }

  /** Called once by FilesService. */
  attachReplacer(r: VersionContentReplacer): void { this.replacer = r; }

  private storeRoot() { return path.resolve(this.config.metaRoot, 'versions'); }

  private itemDir(ownerId: string, itemId: string): string {
    if (!UUID.test(ownerId) || !UUID.test(itemId)) throw new Error(`versions: invalid ids ${ownerId}/${itemId}`);
    return path.join(this.storeRoot(), ownerId, itemId);
  }

  /** True when `abs` is a direct child of the item's version directory (guards every removal). */
  private inItemDir(abs: string, ownerId: string, itemId: string): boolean {
    try {
      return path.dirname(path.resolve(abs)) === this.itemDir(ownerId, itemId);
    } catch {
      return false;
    }
  }

  private assertEnabled(): void {
    if (!this.config.versions) throw new SyncError('not_found', 'versions disabled');
  }

  // ---------------------------------------------------------------- capture

  /**
   * Keeps the current content of `item` (at `absCurrent`) as a version. Must be called inside the
   * caller's transaction, under the user lock, right before the content is replaced; a failure
   * throws (and the caller must not replace). Same file system: hard link (the current file is
   * never moved or modified); otherwise a copy into `<meta>/versions/.tmp-*`, published by rename.
   * No-op when versions are off.
   */
  async capture(tx: Tx, user: IndexUser, item: Item, absCurrent: string, source: VersionSource, by?: string): Promise<void> {
    if (!this.config.versions) return;
    if (item.type !== 'file' || item.ownerId !== user.id) throw new Error('versions: capture of a foreign or non-file item');
    const dir = this.itemDir(item.ownerId, item.id);
    const dst = await this.freeStorePath(tx, item, dir);
    let created = false;
    try {
      const copiedHash = await this.store(absCurrent, dst, dir);
      created = true;
      // A hard link is the row's inode, which the caller verified a moment ago; a copy was hashed.
      const st = await lstat(dst, { bigint: true });
      const sha = copiedHash ?? (st.size === item.size ? item.contentHash : null) ?? (await sha256File(dst));
      // `by` may come from outside (the office callback's editor id): unknown or malformed -> null.
      const createdBy = by && UUID.test(by) && (await tx.user.findUnique({ where: { id: by }, select: { id: true } })) ? by : null;
      await tx.fileVersion.create({
        data: { itemId: item.id, ownerId: item.ownerId, version: item.version, sha, size: st.size, mtime: item.mtime, createdBy, source, storePath: dst },
      });
    } catch (e) {
      if (created) await rm(dst, { force: true }).catch((err) => this.log.error(`cannot remove failed capture ${dst}: ${String(err)}`));
      throw e;
    }
  }

  /**
   * `<version>-<sha|nohash>` in the item's directory. A file with that name and no row is a
   * leftover of a capture whose transaction rolled back: it is replaced (we hold the user lock,
   * so no other capture of this owner runs). A referenced one gets a random suffix instead.
   */
  private async freeStorePath(tx: Tx, item: Item, dir: string): Promise<string> {
    const base = `${item.version}-${item.contentHash ?? 'nohash'}`;
    let name = base;
    for (let attempt = 0; attempt < 10; attempt++) {
      const p = path.join(dir, name);
      if (!(await exists(p))) return p;
      if (!(await tx.fileVersion.findFirst({ where: { itemId: item.id, storePath: p }, select: { id: true } }))) {
        await rm(p, { force: true });
        return p;
      }
      name = `${base}-${randomBytes(4).toString('hex')}`;
    }
    throw new Error(`versions: no free store path in ${dir}`);
  }

  /**
   * Hard link, else copy (fsynced, mtime kept) via a temp in the store root. Returns the sha256 of
   * the copied bytes (null for a hard link). The directory is re-created if a concurrent prune
   * sweep removed it while empty.
   */
  private async store(src: string, dst: string, dir: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      await mkdir(dir, { recursive: true });
      try {
        await link(src, dst);
        return null;
      } catch (e) {
        if (errno(e) === 'ENOENT' && attempt < 3 && (await exists(src))) continue; // dir vanished
        if (!NO_HARDLINK.includes(errno(e) ?? '')) throw e;
      }
      const tmp = path.join(this.storeRoot(), `${TMP_PREFIX}${randomBytes(8).toString('hex')}`);
      try {
        const sha = await this.copyHashed(src, tmp);
        try {
          await rename(tmp, dst);
        } catch (e) {
          if (errno(e) === 'ENOENT' && attempt < 3) continue;
          throw e;
        }
        return sha;
      } finally {
        await rm(tmp, { force: true });
      }
    }
  }

  private async copyHashed(src: string, dst: string): Promise<string> {
    const hash = createHash('sha256');
    const sfh = await open(src, 'r');
    try {
      const dfh = await open(dst, 'wx', 0o600);
      try {
        const buf = Buffer.allocUnsafe(1 << 20);
        for (;;) {
          const { bytesRead } = await sfh.read(buf, 0, buf.length, null);
          if (bytesRead === 0) break;
          hash.update(buf.subarray(0, bytesRead));
          for (let off = 0; off < bytesRead;) off += (await dfh.write(buf, off, bytesRead - off)).bytesWritten;
        }
        const st = await sfh.stat();
        await dfh.utimes(st.atime, st.mtime);
        await dfh.sync();
      } finally {
        await dfh.close();
      }
    } finally {
      await sfh.close();
    }
    return hash.digest('hex');
  }

  // ---------------------------------------------------------------- read

  private async liveFile(user: IndexUser, itemId: string): Promise<Item> {
    const item = UUID.test(itemId) ? await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } }) : null;
    if (!item) throw new SyncError('not_found');
    if (item.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    return item;
  }

  async list(user: IndexUser, itemId: string): Promise<VersionWire[]> {
    this.assertEnabled();
    const item = await this.liveFile(user, itemId);
    const rows = await this.prisma.fileVersion.findMany({ where: { itemId: item.id, ownerId: user.id }, orderBy: [{ createdAt: 'desc' }, { version: 'desc' }, { id: 'asc' }] });
    const byIds = [...new Set(rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])))];
    const users = new Map((byIds.length ? await this.prisma.user.findMany({ where: { id: { in: byIds } }, select: { id: true, displayName: true } }) : []).map((u) => [u.id, u]));
    return rows.map((r) => ({
      id: r.id, version: r.version, size: Number(r.size), sha256: r.sha,
      modifiedAt: r.mtime.toISOString(), createdAt: r.createdAt.toISOString(), source: r.source,
      createdBy: r.createdBy ? { id: r.createdBy, displayName: users.get(r.createdBy)?.displayName ?? '' } : null,
    }));
  }

  /** Resolves a version of a live file of `user` to its stored file (404 for anything else). */
  async openRead(user: IndexUser, itemId: string, versionId: string): Promise<OpenedVersion> {
    this.assertEnabled();
    const item = await this.liveFile(user, itemId);
    const version = UUID.test(versionId) ? await this.prisma.fileVersion.findFirst({ where: { id: versionId, itemId: item.id, ownerId: user.id } }) : null;
    if (!version || !this.inItemDir(version.storePath, user.id, item.id)) throw new SyncError('not_found');
    return { item, version, abs: path.resolve(version.storePath), downloadName: versionDownloadName(item.name, version.version) };
  }

  /**
   * Makes a version the current content again: the current content becomes a version (source
   * `restore`), then the version's bytes replace it through the same atomic path as a PUT
   * (version + 1, journal upsert). The item id never changes; the restored version stays.
   */
  async restore(user: IndexUser, itemId: string, versionId: string): Promise<Item> {
    const { abs } = await this.openRead(user, itemId, versionId);
    if (!this.replacer) throw new Error('versions: no content replacer attached');
    let body: Readable;
    try {
      const fh = await open(abs, 'r');
      body = fh.createReadStream();
    } catch (e) {
      if (errno(e) === 'ENOENT') throw new SyncError('not_found', 'version content missing');
      throw e;
    }
    try {
      return await this.replacer.restoreFromVersion(user, itemId, body);
    } finally {
      body.destroy();
    }
  }

  // ---------------------------------------------------------------- removal

  /** Removes all versions (rows + files) of the given items of `ownerId`. Works even when versions are off. */
  async deleteForItems(ownerId: string, itemIds: string[]): Promise<number> {
    const ids = [...new Set(itemIds.filter((id) => UUID.test(id)))];
    if (!UUID.test(ownerId) || ids.length === 0) return 0;
    let removed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      removed += (await this.prisma.fileVersion.deleteMany({ where: { ownerId, itemId: { in: chunk } } })).count;
      for (const id of chunk) {
        const dir = this.itemDir(ownerId, id);
        await rm(dir, { recursive: true, force: true }).catch((e) => this.log.error(`cannot remove ${dir}: ${String(e)}`));
      }
    }
    return removed;
  }

  /** Deletes rows (under the owner's lock, serialized with captures), then their files. */
  private async dropVersions(ownerId: string, ids: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const rows = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, ownerId);
        const found = await tx.fileVersion.findMany({ where: { id: { in: chunk }, ownerId }, select: { id: true, itemId: true, storePath: true } });
        await tx.fileVersion.deleteMany({ where: { id: { in: found.map((r) => r.id) } } });
        return found;
      }, TX_OPTS);
      for (const r of rows) {
        if (!this.inItemDir(r.storePath, ownerId, r.itemId)) {
          this.log.warn(`not removing version file of ${r.id}: unexpected store path ${r.storePath}`);
          continue;
        }
        await rm(r.storePath, { force: true }).catch((e) => this.log.error(`cannot remove ${r.storePath}: ${String(e)}`));
      }
      removed += rows.length;
    }
    return removed;
  }

  /**
   * Maintenance: removes versions of items that are gone for good (no row, not in any trash
   * manifest), thins out each item's versions by the retention buckets, enforces
   * `SYNCLET_VERSIONS_MAX_BYTES` per user (oldest first, never the newest version of an item) and
   * sweeps stray files of crashed captures. Does nothing while versions are off.
   */
  async prune(now = new Date()): Promise<{ orphaned: number; expired: number; evicted: number; stray: number }> {
    const out = { orphaned: 0, expired: 0, evicted: 0, stray: 0 };
    if (!this.config.versions) return out;
    out.orphaned = await this.pruneOrphans();
    out.expired = await this.pruneRetention(now);
    if (this.config.versionsMaxBytes > 0) out.evicted = await this.pruneMaxBytes(this.config.versionsMaxBytes);
    out.stray = await this.sweepStray(now);
    return out;
  }

  private async pruneOrphans(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ ownerId: string; itemId: string }[]>`
      SELECT DISTINCT v."ownerId"::text AS "ownerId", v."itemId"::text AS "itemId" FROM "FileVersion" v
      WHERE NOT EXISTS (SELECT 1 FROM "Item" i WHERE i.id = v."itemId")
        AND NOT EXISTS (
          SELECT 1 FROM "TrashEntry" t
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.manifest) = 'array' THEN t.manifest ELSE '[]'::jsonb END) e
          WHERE t."ownerId" = v."ownerId" AND (t."itemId" = v."itemId" OR (jsonb_typeof(e) = 'object' AND e->>'id' = v."itemId"::text)))`;
    const byOwner = new Map<string, string[]>();
    for (const r of rows) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r.itemId]);
    let n = 0;
    for (const [ownerId, itemIds] of byOwner) n += await this.deleteForItems(ownerId, itemIds);
    return n;
  }

  private async pruneRetention(now: Date): Promise<number> {
    const groups = await this.prisma.fileVersion.groupBy({ by: ['ownerId', 'itemId'], _count: { _all: true } });
    let n = 0;
    for (const g of groups) {
      if (g._count._all < 2) continue;
      const versions = await this.prisma.fileVersion.findMany({ where: { ownerId: g.ownerId, itemId: g.itemId }, select: { id: true, createdAt: true } });
      const keep = selectVersionsToKeep(versions, now);
      const drop = versions.filter((v) => !keep.has(v.id)).map((v) => v.id);
      if (drop.length) n += await this.dropVersions(g.ownerId, drop);
    }
    return n;
  }

  private async pruneMaxBytes(max: number): Promise<number> {
    const limit = BigInt(max);
    const totals = await this.prisma.fileVersion.groupBy({ by: ['ownerId'], _sum: { size: true } });
    let n = 0;
    for (const t of totals) {
      let total = t._sum.size ?? 0n;
      if (total <= limit) continue;
      const rows = await this.prisma.fileVersion.findMany({
        where: { ownerId: t.ownerId }, select: { id: true, itemId: true, size: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { version: 'asc' }, { id: 'asc' }],
      });
      // The newest version of each item is never evicted (rows are oldest first: the last wins).
      const newest = new Map<string, string>();
      for (const r of rows) newest.set(r.itemId, r.id);
      const protectedIds = new Set(newest.values());
      const drop: string[] = [];
      for (const r of rows) {
        if (total <= limit) break;
        if (protectedIds.has(r.id)) continue;
        drop.push(r.id);
        total -= r.size;
      }
      if (drop.length) n += await this.dropVersions(t.ownerId, drop);
      if (total > limit) this.log.warn(`versions of ${t.ownerId} exceed SYNCLET_VERSIONS_MAX_BYTES even with only the newest version per file kept`);
    }
    return n;
  }

  /**
   * Removes files in the store that no row references (a capture whose transaction rolled back, a
   * crash between row delete and file removal) and `.tmp-*` copies, once older than an hour, plus
   * empty item/owner directories. Only UUID-named directories are descended into.
   */
  private async sweepStray(now: Date): Promise<number> {
    const root = this.storeRoot();
    const old = async (abs: string) => {
      const st = await lstat(abs).catch(() => null);
      return st !== null && !st.isDirectory() && now.getTime() - st.ctimeMs > STRAY_AGE_MS;
    };
    let n = 0;
    for (const owner of await readdir(root).catch(() => [] as string[])) {
      const ownerAbs = path.join(root, owner);
      if (owner.startsWith(TMP_PREFIX)) {
        if (await old(ownerAbs)) { await rm(ownerAbs, { force: true }).catch(() => {}); n++; }
        continue;
      }
      if (!UUID.test(owner)) continue;
      for (const item of await readdir(ownerAbs).catch(() => [] as string[])) {
        if (!UUID.test(item)) continue;
        const dir = path.join(ownerAbs, item);
        const names = await readdir(dir).catch(() => [] as string[]);
        if (names.length) {
          const known = new Set((await this.prisma.fileVersion.findMany({ where: { ownerId: owner, itemId: item }, select: { storePath: true } })).map((r) => path.resolve(r.storePath)));
          for (const name of names) {
            const abs = path.join(dir, name);
            if (known.has(abs) || !(await old(abs))) continue;
            await rm(abs, { force: true }).catch((e) => this.log.error(`cannot remove stray version file ${abs}: ${String(e)}`));
            n++;
          }
        }
        // Racing a capture that just created the directory is harmless: capture re-creates it.
        await rmdir(dir).catch(() => {});
      }
      await rmdir(ownerAbs).catch(() => {});
    }
    if (n) this.log.warn(`removed ${n} stray version file(s)`);
    return n;
  }
}
