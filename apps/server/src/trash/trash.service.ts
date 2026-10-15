import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type Item, type ItemType, type TrashEntry } from '@prisma/client';
import type { RestoreResult, TrashEntryWire } from '@synclet/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey, tempName } from '../common/names';
import { absPath, joinRel, parentRel } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { FilesService, TrashManifestEntry } from '../files/files.service';
import { InsufficientStorageError, isStorageFull, rethrowStorageError } from '../common/storage-errors';
import { copyTree, moveNoReplace, statEntry } from '../files/fs-ops';
import { readDisk } from '../indexer/disk';
import { ItemStore } from '../journal/item-store';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { SerializerService } from '../sync/serializer.service';
import { toSyncId, UUID } from '../sync/sync-ids';
import { VersionsService } from '../versions/versions.service';

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const exists = (p: string) => lstat(p).then(() => true, () => false);
const unavailable = () => new SyncError('conflict', 'trash content not available', undefined, 409);
const busyError = () => new SyncError('conflict', 'trash entry is being processed', undefined, 409);

/** A copy of the trashed content in an ignored temp folder next to the restore target. */
interface StagedCopy { dirRel: string; tmp: string; payload: string }

type CommitOutcome = { done: { item: Item; restoredTo: string; renamed: boolean } } | { needCopy: string };

interface DiskNode { sub: string; parentSub: string | null; name: string; type: ItemType; size: bigint; mtime: Date; ino: bigint; dev: bigint }

interface PlannedRow { node: DiskNode; id: string; mode: 'revive' | 'create'; parentId: string | null; contentHash: string | null }

const ID_CHUNK = 10_000;
const WRITE_CHUNK = 1_000;

function manifestOf(entry: TrashEntry): TrashManifestEntry[] {
  return Array.isArray(entry.manifest) ? (entry.manifest as unknown as TrashManifestEntry[]) : [];
}

@Injectable()
export class TrashService {
  private readonly log = new Logger(TrashService.name);
  /** Entries with a restore / delete in flight in this process (checked and set synchronously). */
  private readonly busy = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly files: FilesService,
    private readonly serializer: SerializerService,
    private readonly versions: VersionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private abs(user: IndexUser, rel: string) { return absPath(this.config.dataRoot, user.username, rel); }

  private trashDir(id: string) { return path.resolve(this.config.metaRoot, 'trash', id); }

  private toWire(e: TrashEntry): TrashEntryWire {
    return {
      id: e.id, itemId: toSyncId({ id: e.itemId, type: e.type }), type: e.type, name: e.name, originalPath: e.originalPath,
      size: Number(e.size), deletedAt: e.deletedAt.toISOString(), expiresAt: e.expiresAt?.toISOString() ?? null,
      itemCount: manifestOf(e).length,
    };
  }

  async list(user: IndexUser): Promise<TrashEntryWire[]> {
    const rows = await this.prisma.trashEntry.findMany({ where: { ownerId: user.id }, orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }] });
    return rows.map((e) => this.toWire(e));
  }

  private async find(user: IndexUser, trashId: string): Promise<TrashEntry> {
    if (!UUID.test(trashId)) throw new SyncError('not_found');
    const entry = await this.prisma.trashEntry.findFirst({ where: { id: trashId, ownerId: user.id } });
    if (!entry) throw new SyncError('not_found');
    return entry;
  }

  /** Marks entries busy; returns only those that were not busy already. Synchronous on purpose. */
  private claim(ids: string[]): string[] {
    const mine = ids.filter((id) => !this.busy.has(id));
    mine.forEach((id) => this.busy.add(id));
    return mine;
  }

  private release(ids: string[]) { ids.forEach((id) => this.busy.delete(id)); }

  // ---------------------------------------------------------------- restore

  /**
   * Restores a trash entry to its original folder (or the root if that folder is gone), under a
   * free name if the original one is taken, with the original item IDs wherever possible.
   * Same file system: the content is renamed into place under the user lock. Otherwise it is first
   * copied (outside the lock) into an ignored temp folder in the target folder, then published.
   * Nothing existing is ever replaced; on failure before commit the trash entry stays intact.
   */
  async restore(user: IndexUser, trashId: string): Promise<RestoreResult> {
    const entry = await this.find(user, trashId);
    if (this.claim([entry.id]).length === 0) throw busyError();
    try {
      if (!(await exists(entry.storePath))) {
        await this.files.pendingTrash(); // the background move to /meta may still be running
        if (!(await exists(entry.storePath))) throw unavailable();
      }
      let copy: StagedCopy | null = null;
      try {
        for (let attempt = 0; ; attempt++) {
          const outcome = await this.commit(user, entry.id, copy, await this.scan(copy ? copy.payload : entry.storePath));
          if ('done' in outcome) {
            if (copy) await rmdir(copy.tmp).catch((e) => this.log.warn(`cannot remove ${copy?.tmp}: ${String(e)}`));
            copy = null;
            await this.removeStore(entry);
            const [item] = await this.serializer.toSyncItems(user, [outcome.done.item]);
            return { item, restoredTo: outcome.done.restoredTo, renamed: outcome.done.renamed };
          }
          // Different file system (or the target folder changed since the last copy): copy first.
          if (copy) await this.dropCopy(copy);
          copy = null;
          if (attempt >= 3) throw new SyncError('conflict', 'restore target keeps changing', undefined, 409);
          copy = await this.stageCopy(user, entry, outcome.needCopy);
        }
      } catch (e) {
        if (copy) await this.dropCopy(copy);
        rethrowStorageError(e);
      }
    } finally {
      this.release([entry.id]);
    }
  }

  /**
   * Copies the trashed content to `<targetDir>/.synclet-tmp-<hex>/<name>`. The temp folder is
   * created non-recursively, so a target folder deleted meanwhile is never re-created.
   */
  private async stageCopy(user: IndexUser, entry: TrashEntry, dirRel: string): Promise<StagedCopy> {
    const tmp = path.join(this.abs(user, dirRel), tempName(randomBytes(8).toString('hex')));
    await mkdir(tmp).catch((e) => Promise.reject(errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR' ? new SyncError('conflict', 'restore target folder vanished', undefined, 409) : isStorageFull(e) ? new InsufficientStorageError() : e));
    const copy = { dirRel, tmp, payload: path.join(tmp, 'payload') };
    try {
      await copyTree(entry.storePath, copy.payload);
    } catch (e) {
      await this.dropCopy(copy);
      rethrowStorageError(e);
    }
    return copy;
  }

  private async dropCopy(copy: StagedCopy): Promise<void> {
    await rm(copy.tmp, { recursive: true, force: true }).catch((e) => this.log.error(`cannot remove restore temp ${copy.tmp}: ${String(e)}`));
  }

  /** Moves trash content into the user folder without replacing anything (EXDEV across mounts). */
  protected moveIn(src: string, dst: string): Promise<void> {
    return moveNoReplace(src, dst);
  }

  /** Live folder of the original parent if it still exists as a real folder, else the root. */
  private async target(tx: Tx, user: IndexUser, entry: TrashEntry): Promise<{ parentId: string | null; dirRel: string }> {
    const rel = parentRel(entry.originalPath);
    if (rel !== '') {
      const p = await this.store.findLiveByPath(tx, user.id, rel);
      if (p?.type === 'folder') {
        try {
          await this.files.assertRealDir(user, rel);
          return { parentId: p.id, dirRel: rel };
        } catch {
          // gone or not a real folder on disk: fall back to the root
        }
      }
    }
    await this.files.assertRealDir(user, '');
    return { parentId: null, dirRel: '' };
  }

  /**
   * Lists the trashed content (outside the lock; nobody else touches a busy entry's content):
   * regular files and folders, pre-order, keyed by the path relative to the trashed item.
   * The stats stay valid after publishing: rename and link keep inode, size and mtime.
   */
  private async scan(src: string): Promise<DiskNode[]> {
    const top = await lstat(src, { bigint: true }).catch((e) => Promise.reject(errno(e) === 'ENOENT' ? unavailable() : e));
    if (!top.isFile() && !top.isDirectory()) throw unavailable();
    const st = await statEntry(src);
    const nodes: DiskNode[] = [{ sub: '', parentSub: null, name: path.basename(src), type: top.isDirectory() ? 'folder' : 'file', ...st }];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'folder') continue;
      for (const c of await readDisk(n.sub === '' ? src : path.join(src, ...n.sub.split('/')), (msg) => this.log.warn(msg))) {
        nodes.push({ ...c, sub: n.sub === '' ? c.name : `${n.sub}/${c.name}`, parentSub: n.sub });
      }
    }
    return nodes;
  }

  /**
   * Decides the row for every scanned entry: the manifest id is revived if its row is tombstoned
   * (same owner and type), created again if the row is gone, and replaced by a new id if it is
   * live (or otherwise unusable). Entries not in the manifest get new ids. One query.
   */
  private async plan(tx: Tx, user: IndexUser, entry: TrashEntry, nodes: DiskNode[]): Promise<PlannedRow[]> {
    const manifest = new Map<string, TrashManifestEntry>();
    for (const m of manifestOf(entry)) {
      const sub = m.path === entry.originalPath ? '' : m.path.startsWith(entry.originalPath + '/') ? m.path.slice(entry.originalPath.length + 1) : null;
      if (sub !== null) manifest.set(sub, m);
    }
    const wantedIds = nodes.map((n) => manifest.get(n.sub)).filter((m): m is TrashManifestEntry => !!m && UUID.test(m.id)).map((m) => m.id);
    const existing = new Map<string, Item>();
    for (let i = 0; i < wantedIds.length; i += ID_CHUNK) {
      for (const r of await tx.item.findMany({ where: { id: { in: wantedIds.slice(i, i + ID_CHUNK) } } })) existing.set(r.id, r);
    }
    const idOf = new Map<string, string>();
    const used = new Set<string>();
    return nodes.map((d) => {
      const m = manifest.get(d.sub);
      const wanted = m && m.type === d.type && UUID.test(m.id) && !used.has(m.id) ? m : undefined;
      const row = wanted ? existing.get(wanted.id) : undefined;
      const revivable = !!row && row.ownerId === user.id && row.deletedAt !== null && row.type === d.type;
      const mode: PlannedRow['mode'] = revivable ? 'revive' : 'create';
      const id = revivable || (wanted && !row) ? wanted!.id : randomUUID();
      used.add(id);
      idOf.set(d.sub, id);
      let contentHash: string | null = null;
      if (d.type === 'file') {
        const sameAsManifest = wanted?.size !== undefined && wanted.mtime !== undefined && BigInt(wanted.size) === d.size && new Date(wanted.mtime).getTime() === d.mtime.getTime();
        if (sameAsManifest) contentHash = wanted?.contentHash ?? null;
        else if (revivable && row!.size === d.size && row!.mtime.getTime() === d.mtime.getTime()) contentHash = row!.contentHash;
      }
      return { node: d, id, mode, parentId: d.parentSub === null ? null : idOf.get(d.parentSub)!, contentHash };
    });
  }

  private async commit(user: IndexUser, entryId: string, copy: StagedCopy | null, nodes: DiskNode[]): Promise<CommitOutcome> {
    let published: { from: string; to: string } | null = null;
    try {
      return await this.prisma.$transaction(async (tx): Promise<CommitOutcome> => {
        await this.journal.lockUser(tx, user.id);
        const entry = await tx.trashEntry.findFirst({ where: { id: entryId, ownerId: user.id } });
        if (!entry) throw new SyncError('not_found');
        const target = await this.target(tx, user, entry);
        if (copy && copy.dirRel !== target.dirRel) return { needCopy: target.dirRel };
        const src = copy ? copy.payload : entry.storePath;
        if (!copy && !(await exists(src))) throw unavailable();

        // Everything is decided before anything becomes visible in the user folder.
        const planned = await this.plan(tx, user, entry, nodes);
        const keys = new Set((await this.store.liveChildren(tx, user.id, target.parentId)).map((s) => s.nameKey));
        const isFolder = nodes[0].type === 'folder';
        let name = entry.name;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) name = freeName(entry.name, keys, isFolder);
          const to = this.abs(user, joinRel(target.dirRel, name));
          try {
            await this.moveIn(src, to);
            published = { from: src, to };
            break;
          } catch (e) {
            if (errno(e) === 'EXDEV' && !copy) return { needCopy: target.dirRel };
            if (errno(e) !== 'EEXIST' || attempt > 100) throw e;
            keys.add(nameKey(name)); // unindexed entry on disk – try the next free name
          }
        }

        // After publishing: bulk writes only.
        const rel = joinRel(target.dirRel, name);
        await this.writeRows(tx, user, planned, target.parentId, rel, name);
        await this.journal.record(tx, user.id, planned.map((p) => ({ id: p.id, type: p.node.type })), 'upsert');
        const sibs = await this.store.sameKeySiblings(tx, user.id, target.parentId, [nameKey(name)], new Set([planned[0].id]));
        await this.journal.record(tx, user.id, sibs, 'upsert');
        await tx.trashEntry.delete({ where: { id: entry.id } });
        const item = await tx.item.findUniqueOrThrow({ where: { id: planned[0].id } });
        return { done: { item, restoredTo: rel, renamed: name !== entry.name } };
      }, TX_OPTS);
    } catch (e) {
      // Rolled back after publishing: take the content back to where it came from.
      const p = published as { from: string; to: string } | null;
      if (p) await moveNoReplace(p.to, p.from).catch((err) => this.log.error(`cannot undo restore ${p.to} -> ${p.from}: ${String(err)}`));
      throw e;
    }
  }

  /** createMany for new/recreated rows, chunked `UPDATE … FROM (VALUES …)` for revived ones. */
  private async writeRows(tx: Tx, user: IndexUser, planned: PlannedRow[], topParentId: string | null, rel: string, name: string): Promise<void> {
    const fields = (p: PlannedRow, i: number) => {
      const d = p.node;
      const n = i === 0 ? name : d.name;
      return {
        parentId: i === 0 ? topParentId : p.parentId, name: n, nameKey: nameKey(n), path: i === 0 ? rel : `${rel}/${d.sub}`,
        size: d.type === 'file' ? d.size : 0n, mtime: d.mtime, ino: d.ino, dev: d.dev, contentHash: p.contentHash,
      };
    };
    const creates = planned.flatMap((p, i) => (p.mode === 'create' ? [{ id: p.id, ownerId: user.id, type: p.node.type, ...fields(p, i) }] : []));
    for (let i = 0; i < creates.length; i += WRITE_CHUNK) await tx.item.createMany({ data: creates.slice(i, i + WRITE_CHUNK) });
    const revives = planned.flatMap((p, i) => (p.mode === 'revive' ? [{ p, f: fields(p, i) }] : []));
    for (let i = 0; i < revives.length; i += WRITE_CHUNK) {
      const values = revives.slice(i, i + WRITE_CHUNK).map(({ p, f }) => Prisma.sql`(${p.id}::uuid, ${f.parentId}::uuid, ${f.name}::text, ${f.nameKey}::text,
        ${f.path}::text, ${f.size.toString()}::bigint, ${f.mtime.toISOString()}::timestamptz, ${f.ino.toString()}::bigint,
        ${f.dev.toString()}::bigint, ${f.contentHash}::text, ${p.node.type === 'file'}::boolean)`);
      const n = await tx.$executeRaw`
        UPDATE "Item" AS i SET "parentId" = v.pid, name = v.name, "nameKey" = v.nkey, path = v.path, size = v.size,
          mtime = v.mtime AT TIME ZONE 'UTC', ino = v.ino, dev = v.dev, "contentHash" = v.hash, "deletedAt" = NULL,
          version = i.version + CASE WHEN v.isfile THEN 1 ELSE 0 END, "updatedAt" = now()
        FROM (VALUES ${Prisma.join(values)}) AS v(id, pid, name, nkey, path, size, mtime, ino, dev, hash, isfile)
        WHERE i.id = v.id AND i."ownerId" = ${user.id}::uuid AND i."deletedAt" IS NOT NULL`;
      // Planned under the same lock, so this only fails on a broken invariant: roll back.
      if (n !== Math.min(WRITE_CHUNK, revives.length - i)) throw new Error('restore: revived row count mismatch');
    }
  }

  // ---------------------------------------------------------------- delete

  async deleteForever(user: IndexUser, trashId: string): Promise<void> {
    const entry = await this.find(user, trashId);
    if (this.claim([entry.id]).length === 0) throw busyError();
    try {
      const removed = await this.dropRows(user.id, [entry.id]);
      if (removed.length === 0) throw new SyncError('not_found');
      await this.purge(removed);
    } finally {
      this.release([entry.id]);
    }
  }

  /** Deletes all trash entries of the user (except those being restored right now). */
  async empty(user: IndexUser): Promise<number> {
    const ids = this.claim((await this.prisma.trashEntry.findMany({ where: { ownerId: user.id }, select: { id: true } })).map((e) => e.id));
    try {
      const removed = await this.dropRows(user.id, ids);
      await this.purge(removed);
      return removed.length;
    } finally {
      this.release(ids);
    }
  }

  /**
   * Deletes entries of all users whose `expiresAt` lies before `now`. With retention 0 entries get
   * no expiry and are kept. Also sweeps orphaned trash directories.
   */
  async expire(now = new Date()): Promise<number> {
    // Entries without an expiry (e.g. from before Phase 1b) get one from the current retention.
    const days = this.config.trashRetentionDays;
    if (days > 0) {
      await this.prisma.$executeRaw`UPDATE "TrashEntry" SET "expiresAt" = "deletedAt" + make_interval(days => ${days}::int) WHERE "expiresAt" IS NULL`;
    }
    const due = await this.prisma.trashEntry.findMany({ where: { expiresAt: { lt: now } }, select: { id: true, ownerId: true } });
    const ids = new Set(this.claim(due.map((e) => e.id)));
    let total = 0;
    try {
      const byOwner = new Map<string, string[]>();
      for (const e of due) if (ids.has(e.id)) byOwner.set(e.ownerId, [...(byOwner.get(e.ownerId) ?? []), e.id]);
      for (const [ownerId, list] of byOwner) {
        try {
          const removed = await this.dropRows(ownerId, list, { expiresAt: { lt: now } });
          await this.purge(removed);
          total += removed.length;
        } catch (e) {
          this.log.error(`trash expiry for ${ownerId} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.release([...ids]);
    }
    if (total) this.log.log(`expired ${total} trash entr${total === 1 ? 'y' : 'ies'}`);
    await this.sweepOrphans().catch((e) => this.log.error(`orphan sweep failed: ${(e as Error).message}`));
    return total;
  }

  /** Deletes the rows under the user lock (serialized with a restore's commit); returns the deleted rows. */
  private async dropRows(ownerId: string, ids: string[], extra: { expiresAt?: { lt: Date } } = {}): Promise<TrashEntry[]> {
    if (ids.length === 0) return [];
    return this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, ownerId);
      const rows = await tx.trashEntry.findMany({ where: { id: { in: ids }, ownerId, ...extra } });
      await tx.trashEntry.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      return rows;
    }, TX_OPTS);
  }

  /**
   * Removes the stored content of deleted rows (after the background move to /meta has settled)
   * and the file versions of every item in their manifests.
   */
  private async purge(entries: TrashEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // A move still queued would otherwise re-create the store path after we removed it.
    await this.files.pendingTrash();
    for (const e of entries) {
      await this.removeStore(e);
      await this.removeVersions(e).catch((err) => this.log.error(`cannot remove versions of trash entry ${e.id}: ${(err as Error).message}`));
    }
  }

  /**
   * Versions follow the item id and stay while the item is in the trash; they go with the entry.
   * Ids that are live again (never expected: a restore deletes the entry) keep their versions.
   */
  private async removeVersions(entry: TrashEntry): Promise<void> {
    const ids = [...new Set([entry.itemId, ...manifestOf(entry).map((m) => m.id)])].filter((id) => UUID.test(id));
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const live = new Set((await this.prisma.item.findMany({ where: { id: { in: chunk }, deletedAt: null }, select: { id: true } })).map((r) => r.id));
      await this.versions.deleteForItems(entry.ownerId, chunk.filter((id) => !live.has(id)));
    }
  }

  /**
   * Removes `/meta/trash/<id>`. Refuses (logs and skips) unless `storePath` is exactly
   * `/meta/trash/<entry.id>/<entry.name>`, so a corrupt row can never remove anything else.
   */
  private async removeStore(entry: TrashEntry): Promise<void> {
    const dir = this.trashDir(entry.id);
    const store = path.resolve(entry.storePath);
    if (!UUID.test(entry.id) || store !== path.join(dir, entry.name) || path.dirname(store) !== dir) {
      this.log.warn(`not removing trash content of ${entry.id}: unexpected store path ${entry.storePath}`);
      return;
    }
    await rm(dir, { recursive: true, force: true }).catch((e) => this.log.error(`cannot remove ${dir}: ${String(e)}`));
  }

  /**
   * Removes `/meta/trash/<uuid>` directories without a TrashEntry (left by a crash between the
   * row delete and the file removal). A row is always created before its directory, so a
   * directory without a row is never one still being filled. Only UUID-named real directories
   * directly below /meta/trash are touched.
   */
  async sweepOrphans(): Promise<number> {
    const trashRoot = path.resolve(this.config.metaRoot, 'trash');
    const names = (await readdir(trashRoot).catch(() => [] as string[])).filter((n) => UUID.test(n) && !this.busy.has(n));
    let removed = 0;
    for (let i = 0; i < names.length; i += ID_CHUNK) {
      const chunk = names.slice(i, i + ID_CHUNK);
      const known = new Set((await this.prisma.trashEntry.findMany({ where: { id: { in: chunk } }, select: { id: true } })).map((r) => r.id));
      for (const n of chunk) {
        if (known.has(n) || this.busy.has(n)) continue;
        const abs = path.join(trashRoot, n);
        const st = await lstat(abs).catch(() => null);
        if (!st?.isDirectory()) continue;
        try {
          await rm(abs, { recursive: true, force: true });
          removed++;
        } catch (e) {
          this.log.error(`cannot remove orphaned trash directory ${abs}: ${String(e)}`);
        }
      }
    }
    if (removed) this.log.warn(`removed ${removed} orphaned trash director${removed === 1 ? 'y' : 'ies'}`);
    return removed;
  }
}
