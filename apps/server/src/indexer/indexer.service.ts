import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { nameKey } from '../common/names';
import { absPath, joinRel, parentRel, userRoot } from '../common/paths';
import type { IndexUser } from '../common/types';
import { ItemStore } from '../journal/item-store';
import { ItemRef, JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { DiskEntry, readDisk } from './disk';

export interface ReconcileStats { created: number; updated: number; moved: number; deleted: number }

interface QueueEntry { dir: string; recursive: boolean }
type OneResult =
  | { kind: 'ok'; subdirs: string[]; newDirs: string[] }
  | { kind: 'missing-dir' }
  | { kind: 'missing-parent' }
  | { kind: 'refused' };
type TxResult =
  | { kind: 'ok'; subdirs: string[]; newDirs: string[]; parentId: string | null; pending: DiskEntry[] }
  | Exclude<OneResult, { kind: 'ok' }>;
export interface InodeRef { dev: bigint | null; ino: bigint | null }
export interface ChildRef extends InodeRef { type: Item['type']; size: bigint; mtime: Date }

const isErrno = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? '');
const inodeKey = (r: InodeRef) => `${r.dev}:${r.ino}`;
/** Size of IN lists / bulk statements (well below Postgres' 32767 bind parameters). */
const BATCH = 1000;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Folder inode-reuse guard: a disk folder may only be paired with an existing folder row when there is
 * evidence that it is the same folder – both are empty, or at least one former child is in the new folder.
 * A former child only counts if it would itself be paired: same inode and type and, for files, the same
 * size and mtime (file systems like ext4 hand a freed inode straight to the next new file).
 */
export function folderMoveHasEvidence(oldChildren: ChildRef[], newChildren: ChildRef[]): boolean {
  if (oldChildren.length === 0) return newChildren.length === 0;
  const fresh = new Map(newChildren.map((c) => [inodeKey(c), c]));
  return oldChildren.some((c) => {
    if (c.ino === null || c.dev === null) return false;
    const n = fresh.get(inodeKey(c));
    if (!n || n.type !== c.type) return false;
    return c.type === 'folder' || (n.size === c.size && n.mtime.getTime() === c.mtime.getTime());
  });
}

@Injectable()
export class IndexerService {
  private readonly log = new Logger(IndexerService.name);
  /** New entries per transaction; a larger directory is created in several lock-holding transactions. */
  createChunk = 2000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
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
    const { stats, refused } = await this.run(user, '', true);
    return refused ? null : stats;
  }

  async reconcileDir(user: IndexUser, relDir: string, opts: { recursive: boolean }): Promise<ReconcileStats> {
    return (await this.run(user, relDir, opts.recursive)).stats;
  }

  private async run(user: IndexUser, relDir: string, recursive0: boolean): Promise<{ stats: ReconcileStats; refused: boolean }> {
    const stats: ReconcileStats = { created: 0, updated: 0, moved: 0, deleted: 0 };
    let refused = false;
    const queue: QueueEntry[] = [{ dir: relDir, recursive: recursive0 }];
    while (queue.length) {
      const { dir, recursive } = queue.shift()!;
      let res: OneResult;
      try {
        res = await this.reconcileOne(user, dir, stats);
      } catch (e) {
        // One broken directory (EIO, ESTALE, tx timeout …) must not stop the rest of the scan.
        // Its transaction rolled back, so nothing was tombstoned or journaled for it.
        this.log.error(`reconciling "${dir}" for ${user.username} failed: ${(e as Error).message}`, (e as Error).stack);
        continue;
      }
      if (res.kind === 'refused') { refused = true; continue; }
      if (res.kind === 'missing-parent') {
        // The directory is not indexed yet: rescan the nearest ancestor that is.
        queue.push({ dir: parentRel(dir), recursive: true });
        continue;
      }
      if (res.kind === 'missing-dir') continue;
      const next = recursive ? res.subdirs : res.newDirs;
      for (const d of next) queue.push({ dir: d, recursive: recursive || res.newDirs.includes(d) });
    }
    return { stats, refused };
  }

  /** Disk listing seam (spied on in tests). */
  protected listDisk(abs: string): Promise<DiskEntry[]> {
    return readDisk(abs, (m) => this.log.warn(m));
  }

  private async reconcileOne(user: IndexUser, dir: string, stats: ReconcileStats): Promise<OneResult> {
    const abs = absPath(this.config.dataRoot, user.username, dir);
    const first: TxResult = await this.prisma.$transaction(async (tx): Promise<TxResult> => {
      await this.journal.lockUser(tx, user.id);
      let parentId: string | null = null;
      if (dir !== '') {
        const parent = await this.store.findLiveByPath(tx, user.id, dir);
        if (!parent || parent.type !== 'folder') {
          const exists = await lstat(abs).then((s) => s.isDirectory(), () => false);
          return exists ? { kind: 'missing-parent' } : { kind: 'missing-dir' };
        }
        parentId = parent.id;
      }
      // Read the disk while holding the lock so API writes cannot interleave with this snapshot.
      let disk: DiskEntry[];
      try {
        disk = await this.listDisk(abs);
      } catch (e) {
        if (isErrno(e, 'ENOENT', 'ENOTDIR')) return { kind: 'missing-dir' };
        if (isErrno(e, 'EACCES', 'EPERM')) {
          // Unreadable directory: leave its rows untouched instead of aborting the whole scan.
          this.log.warn(`cannot read ${abs}: ${(e as Error).message}`);
          return { kind: 'missing-dir' };
        }
        throw e;
      }
      if (dir === '' && disk.length === 0 && (await this.refuseEmptyRoot(tx, user, abs))) return { kind: 'refused' };
      return this.applyDiff(tx, user, dir, parentId, disk, stats);
    }, TX_OPTS);
    if (first.kind !== 'ok') return first;

    // Creates beyond the first chunk run in their own transactions so a huge directory cannot hit the tx timeout.
    const { subdirs, newDirs, parentId } = first;
    for (const part of chunks(first.pending, this.createChunk)) {
      const ok = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        if (parentId !== null) {
          const parent = await this.store.getLive(tx, user.id, parentId);
          if (!parent || parent.path !== dir) return false; // moved/deleted meanwhile: a later reconcile catches up
        }
        const still = await this.stillPending(tx, user, dir, parentId, part);
        newDirs.push(...(await this.createEntries(tx, user, dir, parentId, still, stats)));
        return true;
      }, TX_OPTS);
      if (!ok) break;
    }
    return { kind: 'ok', subdirs, newDirs };
  }

  /** Mass-deletion guard for an empty user root (unmounted volume, wiped mount point, …). */
  private async refuseEmptyRoot(tx: Tx, user: IndexUser, abs: string): Promise<boolean> {
    const liveRoot = await tx.item.count({ where: { ownerId: user.id, parentId: null, deletedAt: null } });
    if (liveRoot === 0) return false;
    const limit = this.config.massDeleteThreshold;
    const unmounted = !(await this.dataRootLooksMounted());
    if (!unmounted && !(limit > 0 && liveRoot > limit)) return false;
    this.log.error(
      `user root ${abs} is empty but ${liveRoot} item(s) are indexed there – refusing to delete them ` +
        (unmounted
          ? '(data root looks unmounted). Check the SYNCLET_DATA mount and restart the server.'
          : `(more than SYNCLET_MASS_DELETE_THRESHOLD=${limit}). If the deletion is intended, ` +
            'set SYNCLET_MASS_DELETE_THRESHOLD=0 and restart the server (then set it back).'),
    );
    return true;
  }

  private async applyDiff(tx: Tx, user: IndexUser, dir: string, parentId: string | null, disk: DiskEntry[], stats: ReconcileStats): Promise<TxResult> {
    const rows = await this.store.liveChildren(tx, user.id, parentId);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const diskByName = new Map(disk.map((e) => [e.name, e]));
    const seen = new Set<string>();
    const upserts: ItemRef[] = [];
    const deletes: ItemRef[] = [];
    const touchedKeys = new Map<string | null, Set<string>>(); // parentId -> nameKeys whose display names may shift
    const touch = (pid: string | null, key: string) => (touchedKeys.get(pid) ?? touchedKeys.set(pid, new Set()).get(pid)!).add(key);
    const unmatched: DiskEntry[] = [];
    const subdirs: string[] = [];
    const newDirs: string[] = [];
    const inoOnly: { id: string; ino: bigint; dev: bigint }[] = [];

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
        inoOnly.push({ id: row.id, ino: e.ino, dev: e.dev });
      }
    }
    // Inode bookkeeping only: no journal entry, so updatedAt (the folder etag) is deliberately left alone.
    for (const part of chunks(inoOnly, BATCH)) {
      await tx.$executeRaw`
        UPDATE "Item" AS i SET ino = u.ino, dev = u.dev
        FROM unnest(${part.map((p) => p.id)}::uuid[], ${part.map((p) => String(p.ino))}::bigint[], ${part.map((p) => String(p.dev))}::bigint[]) AS u(id, ino, dev)
        WHERE i.id = u.id`;
    }

    // 2) Rows whose name now has a different type must go before new rows take their path.
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const e = diskByName.get(row.name);
      if (e && e.type !== row.type) {
        deletes.push(...(await this.store.tombstoneSubtree(tx, row)));
        seen.add(row.id); stats.deleted++; touch(parentId, row.nameKey);
      }
    }

    // 3) New names: inode match => move/rename (ID kept), else create (step 6).
    const cands = await this.moveCandidates(tx, user, unmatched);
    const listings = new Map<string, Promise<Set<string> | null>>(); // per-call parent listing cache for stillAtPath
    const creates: DiskEntry[] = [];
    for (const e of unmatched) {
      const rel = joinRel(dir, e.name);
      const key = nameKey(e.name);
      const cand = await this.pickCandidate(tx, user, dir, e, cands.get(inodeKey(e)) ?? [], seen, listings);
      if (!cand) { creates.push(e); continue; }
      const wasLive = cand.deletedAt === null;
      await tx.item.update({
        where: { id: cand.id },
        data: { parentId, name: e.name, nameKey: key, path: rel, deletedAt: null, ino: e.ino, dev: e.dev, mtime: e.mtime },
      });
      if (cand.type === 'folder' && wasLive) await this.store.rewritePrefix(tx, user.id, cand.path, rel);
      seen.add(cand.id); upserts.push(cand); stats.moved++;
      if (cand.parentId !== parentId) touch(cand.parentId, cand.nameKey);
      if (e.type === 'folder' && !wasLive) newDirs.push(rel); // resurrected folder: re-pair its children
      touch(parentId, key);
    }

    // 4) Rows not found on disk: tombstone (kept for tombstoneWindowSec to pair later moves).
    const goneFiles: Item[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      if (row.type === 'folder') deletes.push(...(await this.store.tombstoneSubtree(tx, row)));
      else goneFiles.push(row);
      stats.deleted++; touch(parentId, row.nameKey);
    }
    const now = new Date();
    for (const part of chunks(goneFiles, BATCH)) {
      await tx.item.updateMany({ where: { id: { in: part.map((r) => r.id) } }, data: { deletedAt: now } });
      deletes.push(...part);
    }

    // 5) Siblings whose display name may change (case/NFC duplicates) are re-announced.
    const changedIds = new Set([...upserts, ...deletes].map((r) => r.id));
    for (const [pid, keys] of touchedKeys) upserts.push(...(await this.sameKeySiblings(tx, user, pid, keys, changedIds)));
    await this.recordChunked(tx, user, deletes, 'delete');
    const deletedIds = new Set(deletes.map((d) => d.id));
    await this.recordChunked(tx, user, upserts.filter((u) => !deletedIds.has(u.id)), 'upsert');

    // 6) Creates: the first chunk here, the rest in follow-up transactions (see reconcileOne).
    newDirs.push(...(await this.createEntries(tx, user, dir, parentId, creates.slice(0, this.createChunk), stats)));
    return { kind: 'ok', subdirs, newDirs, parentId, pending: creates.slice(this.createChunk) };
  }

  /** Bulk-inserts new rows (client-side IDs) and journals them. Returns the new folders' paths. */
  private async createEntries(tx: Tx, user: IndexUser, dir: string, parentId: string | null, entries: DiskEntry[], stats: ReconcileStats): Promise<string[]> {
    if (entries.length === 0) return [];
    const data = entries.map((e) => ({
      id: randomUUID(), ownerId: user.id, parentId, type: e.type, name: e.name, nameKey: nameKey(e.name),
      path: joinRel(dir, e.name), size: e.size, mtime: e.mtime, ino: e.ino, dev: e.dev,
    }));
    for (const part of chunks(data, BATCH)) await tx.item.createMany({ data: part });
    stats.created += data.length;
    const created = new Set(data.map((d) => d.id));
    const siblings = await this.sameKeySiblings(tx, user, parentId, new Set(data.map((d) => d.nameKey)), created);
    await this.recordChunked(tx, user, [...data.map((d) => ({ id: d.id, type: d.type })), ...siblings], 'upsert');
    return data.filter((d) => d.type === 'folder').map((d) => d.path);
  }

  /** Re-validates deferred creates under a fresh lock: still on disk with the same inode, name still free. */
  private async stillPending(tx: Tx, user: IndexUser, dir: string, parentId: string | null, part: DiskEntry[]): Promise<DiskEntry[]> {
    const taken = new Set(
      (await tx.item.findMany({ where: { ownerId: user.id, parentId, deletedAt: null, name: { in: part.map((e) => e.name) } }, select: { name: true } }))
        .map((r) => r.name),
    );
    const out: DiskEntry[] = [];
    for (const group of chunks(part, 64)) {
      const ok = await Promise.all(group.map(async (e) => {
        const rel = joinRel(dir, e.name);
        if (taken.has(e.name)) return false;
        const st = await lstat(absPath(this.config.dataRoot, user.username, rel), { bigint: true }).catch(() => null);
        return !!st && st.ino === e.ino && st.dev === e.dev && (e.type === 'folder' ? st.isDirectory() : st.isFile());
      }));
      group.forEach((e, i) => { if (ok[i]) out.push(e); });
    }
    return out;
  }

  /** All rows (live or recently tombstoned) sharing dev+ino with one of `entries`, newest first per inode. */
  private async moveCandidates(tx: Tx, user: IndexUser, entries: DiskEntry[]): Promise<Map<string, Item[]>> {
    const out = new Map<string, Item[]>();
    if (entries.length === 0) return out;
    const windowStart = new Date(Date.now() - this.config.tombstoneWindowSec * 1000);
    const wanted = new Set(entries.map(inodeKey));
    for (const part of chunks([...new Set(entries.map((e) => e.ino))], BATCH)) {
      const rows = await tx.item.findMany({
        where: { ownerId: user.id, ino: { in: part }, OR: [{ deletedAt: null }, { deletedAt: { gte: windowStart } }] },
        orderBy: { updatedAt: 'desc' },
      });
      for (const r of rows) {
        const k = inodeKey(r);
        if (wanted.has(k)) (out.get(k) ?? out.set(k, []).get(k)!).push(r);
      }
    }
    return out;
  }

  private async pickCandidate(
    tx: Tx, user: IndexUser, dir: string, e: DiskEntry, cands: Item[], seen: Set<string>,
    listings: Map<string, Promise<Set<string> | null>>,
  ): Promise<Item | null> {
    for (const c of cands) {
      if (c.type !== e.type || seen.has(c.id)) continue;
      // Guard against inode reuse: files must keep size and mtime across a move …
      if (e.type === 'file' && (c.size !== e.size || c.mtime.getTime() !== e.mtime.getTime())) continue;
      // A live row only moved if its old path is gone (otherwise it is a hard link).
      if (c.deletedAt === null && (await this.stillAtPath(user, c, listings))) continue;
      // … and folders must share content with the folder they would continue.
      if (e.type === 'folder' && !(await this.folderEvidence(tx, user, c, joinRel(dir, e.name)))) continue;
      return c;
    }
    return null;
  }

  private async folderEvidence(tx: Tx, user: IndexUser, cand: Item, newRel: string): Promise<boolean> {
    // Live candidate: its live children. Tombstoned candidate: the children tombstoned together with it.
    const oldChildren = await tx.item.findMany({
      where: { ownerId: user.id, parentId: cand.id, deletedAt: cand.deletedAt },
      select: { dev: true, ino: true, type: true, size: true, mtime: true },
    });
    let fresh: DiskEntry[];
    try {
      fresh = await this.listDisk(absPath(this.config.dataRoot, user.username, newRel));
    } catch {
      return false;
    }
    return folderMoveHasEvidence(oldChildren, fresh);
  }

  /** True if `item` still exists on disk under its exact recorded name. */
  private async stillAtPath(user: IndexUser, item: Item, listings: Map<string, Promise<Set<string> | null>>): Promise<boolean> {
    const abs = absPath(this.config.dataRoot, user.username, item.path);
    const st = await lstat(abs, { bigint: true }).catch(() => null);
    if (!st || st.ino !== item.ino || st.dev !== item.dev) return false;
    // Case/normalization-insensitive file systems (APFS, SMB) resolve "a.txt" to "A.txt" after a
    // case-only rename, so the lstat alone would mistake the renamed file for a hard link.
    const dirAbs = path.dirname(abs);
    let names = listings.get(dirAbs);
    if (!names) {
      names = readdir(dirAbs).then((n) => new Set(n), () => null);
      listings.set(dirAbs, names);
    }
    const set = await names;
    return set === null || set.has(item.name); // unreadable parent: assume still there (no false move)
  }

  private async sameKeySiblings(tx: Tx, user: IndexUser, parentId: string | null, keys: Set<string>, exclude: Set<string>): Promise<Item[]> {
    const out: Item[] = [];
    for (const part of chunks([...keys], BATCH)) {
      const rows = await this.store.sameKeySiblings(tx, user.id, parentId, part, new Set());
      out.push(...rows.filter((r) => !exclude.has(r.id)));
    }
    return out;
  }

  private async recordChunked(tx: Tx, user: IndexUser, refs: ItemRef[], op: 'upsert' | 'delete'): Promise<void> {
    for (const part of chunks(refs, BATCH)) await this.journal.record(tx, user.id, part, op);
  }
}
