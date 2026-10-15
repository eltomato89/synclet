import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { nameKey } from '../common/names';
import { absPath, joinRel, parentRel, userRoot } from '../common/paths';
import type { IndexUser } from '../common/types';
import { BusyPaths } from '../journal/busy-paths';
import { ItemStore } from '../journal/item-store';
import { ItemRef, JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { DiskEntry, readDisk } from './disk';

export interface ReconcileStats { created: number; updated: number; moved: number; deleted: number }

interface QueueEntry { dir: string; recursive: boolean }
type OneResult = { kind: 'ok'; subdirs: string[]; newDirs: string[] } | { kind: 'missing-dir' } | { kind: 'missing-parent' };

const isErrno = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? '');

@Injectable()
export class IndexerService {
  private readonly log = new Logger(IndexerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly busy: BusyPaths,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Mass-deletion guard: an empty or missing data root almost always means an unmounted volume. */
  async dataRootLooksMounted(): Promise<boolean> {
    try {
      const entries = await readdir(this.config.dataRoot, { withFileTypes: true });
      return entries.some((e) => e.isDirectory());
    } catch {
      return false;
    }
  }

  async fullScan(user: IndexUser): Promise<ReconcileStats | null> {
    const root = userRoot(this.config.dataRoot, user.username);
    const rootOk = await lstat(root).then((s) => s.isDirectory(), () => false);
    if (!rootOk || !(await this.dataRootLooksMounted())) {
      this.log.error(`user root ${root} missing or data root empty – refusing to scan (unmounted volume?)`);
      return null;
    }
    return this.reconcileDir(user, '', { recursive: true });
  }

  async reconcileDir(user: IndexUser, relDir: string, opts: { recursive: boolean }): Promise<ReconcileStats> {
    const stats: ReconcileStats = { created: 0, updated: 0, moved: 0, deleted: 0 };
    const queue: QueueEntry[] = [{ dir: relDir, recursive: opts.recursive }];
    while (queue.length) {
      const { dir, recursive } = queue.shift()!;
      if (dir !== '' && this.busy.covers(user.id, dir)) continue;
      const res = await this.reconcileOne(user, dir, stats);
      if (res.kind === 'missing-parent') {
        // The directory is not indexed yet: rescan the nearest ancestor that is.
        queue.push({ dir: parentRel(dir), recursive: true });
        continue;
      }
      if (res.kind === 'missing-dir') continue;
      const next = recursive ? res.subdirs : res.newDirs;
      for (const d of next) queue.push({ dir: d, recursive: recursive || res.newDirs.includes(d) });
    }
    return stats;
  }

  private async reconcileOne(user: IndexUser, dir: string, stats: ReconcileStats): Promise<OneResult> {
    const abs = absPath(this.config.dataRoot, user.username, dir);
    return this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, user.id);
      let parentId: string | null = null;
      if (dir !== '') {
        const parent = await this.store.findLiveByPath(tx, user.id, dir);
        if (!parent || parent.type !== 'folder') {
          const exists = await lstat(abs).then((s) => s.isDirectory(), () => false);
          return exists ? { kind: 'missing-parent' as const } : { kind: 'missing-dir' as const };
        }
        parentId = parent.id;
      }
      // Read the disk while holding the lock so API writes cannot interleave with this snapshot.
      let disk: DiskEntry[];
      try {
        disk = await readDisk(abs, (m) => this.log.warn(m));
      } catch (e) {
        if (isErrno(e, 'ENOENT', 'ENOTDIR')) return { kind: 'missing-dir' as const };
        if (isErrno(e, 'EACCES', 'EPERM')) {
          // Unreadable directory: leave its rows untouched instead of aborting the whole scan.
          this.log.warn(`cannot read ${abs}: ${(e as Error).message}`);
          return { kind: 'missing-dir' as const };
        }
        throw e;
      }
      disk = disk.filter((e) => !this.busy.covers(user.id, joinRel(dir, e.name)));
      return this.applyDiff(tx, user, dir, parentId, disk, stats);
    }, TX_OPTS);
  }

  private async applyDiff(tx: Tx, user: IndexUser, dir: string, parentId: string | null, disk: DiskEntry[], stats: ReconcileStats): Promise<OneResult> {
    const rows = await this.store.liveChildren(tx, user.id, parentId);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const diskByName = new Map(disk.map((e) => [e.name, e]));
    const seen = new Set<string>();
    // Busy paths were filtered out of `disk`; their rows must not be mistaken for deletions either.
    for (const r of rows) if (this.busy.covers(user.id, r.path)) seen.add(r.id);
    const upserts: ItemRef[] = [];
    const deletes: ItemRef[] = [];
    const touchedKeys = new Map<string | null, Set<string>>(); // parentId -> nameKeys whose display names may shift
    const touch = (pid: string | null, key: string) => (touchedKeys.get(pid) ?? touchedKeys.set(pid, new Set()).get(pid)!).add(key);
    const unmatched: DiskEntry[] = [];
    const subdirs: string[] = [];
    const newDirs: string[] = [];

    // 1) Same name: same item (even with a new inode – editors save via temp + rename).
    for (const e of disk) {
      const rel = joinRel(dir, e.name);
      if (e.type === 'folder') subdirs.push(rel);
      const row = byName.get(e.name);
      if (!row || row.type !== e.type) { unmatched.push(e); continue; }
      seen.add(row.id);
      const contentChanged = e.type === 'file' && (row.size !== e.size || row.mtime.getTime() !== e.mtime.getTime());
      if (contentChanged) {
        await tx.item.update({ where: { id: row.id }, data: { size: e.size, mtime: e.mtime, ino: e.ino, dev: e.dev, contentHash: null, version: { increment: 1 } } });
        upserts.push(row); stats.updated++;
      } else if (row.ino !== e.ino || row.dev !== e.dev) {
        await tx.item.update({ where: { id: row.id }, data: { ino: e.ino, dev: e.dev } });
      }
    }

    // 2) Rows whose name now has a different type must go before new rows take their path.
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const e = diskByName.get(row.name);
      if (e && e.type !== row.type) {
        const gone = await this.store.tombstoneSubtree(tx, row);
        deletes.push(...gone); seen.add(row.id); stats.deleted++; touch(parentId, row.nameKey);
      }
    }

    // 3) New names: inode match => move/rename (ID kept), else create.
    for (const e of unmatched) {
      const rel = joinRel(dir, e.name);
      const key = nameKey(e.name);
      const cand = await this.findMoveCandidate(tx, user, e, seen);
      if (cand) {
        const wasLive = cand.deletedAt === null;
        await tx.item.update({
          where: { id: cand.id },
          data: { parentId, name: e.name, nameKey: key, path: rel, deletedAt: null, ino: e.ino, dev: e.dev, mtime: e.mtime },
        });
        if (cand.type === 'folder' && wasLive) await this.store.rewritePrefix(tx, user.id, cand.path, rel);
        seen.add(cand.id); upserts.push(cand); stats.moved++;
        if (cand.parentId !== parentId) touch(cand.parentId, cand.nameKey);
        if (e.type === 'folder' && !wasLive) newDirs.push(rel); // resurrected folder: re-pair its children
      } else {
        const created = await tx.item.create({
          data: { ownerId: user.id, parentId, type: e.type, name: e.name, nameKey: key, path: rel, size: e.size, mtime: e.mtime, ino: e.ino, dev: e.dev },
        });
        upserts.push(created); stats.created++;
        if (e.type === 'folder') newDirs.push(rel);
      }
      touch(parentId, key);
    }

    // 4) Rows not found on disk: tombstone (kept for tombstoneWindowSec to pair later moves).
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const gone = await this.store.tombstoneSubtree(tx, row);
      deletes.push(...gone); stats.deleted++; touch(parentId, row.nameKey);
    }

    // 5) Siblings whose display name may change (case/NFC duplicates) are re-announced.
    const changedIds = new Set([...upserts, ...deletes].map((r) => r.id));
    for (const [pid, keys] of touchedKeys) {
      upserts.push(...(await this.store.sameKeySiblings(tx, user.id, pid, [...keys], changedIds)));
    }

    await this.journal.record(tx, user.id, deletes, 'delete');
    const deletedIds = new Set(deletes.map((d) => d.id));
    await this.journal.record(tx, user.id, upserts.filter((u) => !deletedIds.has(u.id)), 'upsert');
    return { kind: 'ok', subdirs, newDirs };
  }

  private async findMoveCandidate(tx: Tx, user: IndexUser, e: DiskEntry, seen: Set<string>): Promise<Item | null> {
    const windowStart = new Date(Date.now() - this.config.tombstoneWindowSec * 1000);
    const cands = await tx.item.findMany({
      where: { ownerId: user.id, dev: e.dev, ino: e.ino, type: e.type, OR: [{ deletedAt: null }, { deletedAt: { gte: windowStart } }] },
      orderBy: { updatedAt: 'desc' },
    });
    for (const c of cands) {
      if (seen.has(c.id) || this.busy.covers(user.id, c.path)) continue;
      // Guard against inode reuse: files must keep size and mtime across a move.
      if (e.type === 'file' && (c.size !== e.size || c.mtime.getTime() !== e.mtime.getTime())) continue;
      // A live row only moved if its old path is gone (otherwise it is a hard link).
      if (c.deletedAt === null && (await this.stillAtPath(user, c))) continue;
      return c;
    }
    return null;
  }

  /** True if `item` still exists on disk under its exact recorded name. */
  private async stillAtPath(user: IndexUser, item: Item): Promise<boolean> {
    const abs = absPath(this.config.dataRoot, user.username, item.path);
    const st = await lstat(abs, { bigint: true }).catch(() => null);
    if (!st || st.ino !== item.ino || st.dev !== item.dev) return false;
    // Case/normalization-insensitive file systems (APFS, SMB) resolve "a.txt" to "A.txt" after a
    // case-only rename, so the lstat alone would mistake the renamed file for a hard link.
    const names = await readdir(path.dirname(abs)).catch(() => [] as string[]);
    return names.includes(item.name);
  }
}
