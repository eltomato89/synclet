import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item, ItemType, TrashEntry } from '@prisma/client';
import type { RestoreResult, TrashEntryWire } from '@synclet/shared';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey, tempName } from '../common/names';
import { absPath, joinRel, parentRel } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { FilesService, TrashManifestEntry } from '../files/files.service';
import { copyTree, moveNoReplace, statEntry } from '../files/fs-ops';
import { readDisk } from '../indexer/disk';
import { ItemStore } from '../journal/item-store';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { SerializerService } from '../sync/serializer.service';
import { toSyncId, UUID } from '../sync/sync-ids';

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const exists = (p: string) => lstat(p).then(() => true, () => false);
const unavailable = () => new SyncError('conflict', 'trash content not available', undefined, 409);
const busyError = () => new SyncError('conflict', 'trash entry is being processed', undefined, 409);

/** A copy of the trashed content in an ignored temp folder next to the restore target. */
interface StagedCopy { dirRel: string; tmp: string; payload: string }

type CommitOutcome = { done: { item: Item; restoredTo: string; renamed: boolean } } | { needCopy: string };

interface DiskNode { name: string; type: ItemType; size: bigint; mtime: Date; ino: bigint; dev: bigint }

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
          const outcome = await this.commit(user, entry.id, copy);
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
        throw e;
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
    await mkdir(tmp).catch((e) => Promise.reject(errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR' ? new SyncError('conflict', 'restore target folder vanished', undefined, 409) : e));
    const copy = { dirRel, tmp, payload: path.join(tmp, 'payload') };
    try {
      await copyTree(entry.storePath, copy.payload);
    } catch (e) {
      await this.dropCopy(copy);
      throw e;
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

  private async commit(user: IndexUser, entryId: string, copy: StagedCopy | null): Promise<CommitOutcome> {
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

        const keys = new Set((await this.store.liveChildren(tx, user.id, target.parentId)).map((s) => s.nameKey));
        const isFolder = entry.type === 'folder';
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

        const rel = joinRel(target.dirRel, name);
        const manifest = new Map<string, TrashManifestEntry>();
        for (const m of manifestOf(entry)) {
          const sub = m.path === entry.originalPath ? '' : m.path.startsWith(entry.originalPath + '/') ? m.path.slice(entry.originalPath.length + 1) : null;
          if (sub !== null) manifest.set(sub, m);
        }
        const st = await statEntry(this.abs(user, rel));
        const top: DiskNode = { name, type: entry.type, ...st };
        const rows: Item[] = [];
        await this.place(tx, user, top, rel, '', target.parentId, manifest, rows);

        await this.journal.record(tx, user.id, rows, 'upsert');
        const sibs = await this.store.sameKeySiblings(tx, user.id, target.parentId, [nameKey(name)], new Set(rows.map((r) => r.id)));
        await this.journal.record(tx, user.id, sibs, 'upsert');
        await tx.trashEntry.delete({ where: { id: entry.id } });
        return { done: { item: rows[0], restoredTo: rel, renamed: name !== entry.name } };
      }, TX_OPTS);
    } catch (e) {
      // Rolled back after publishing: take the content back to where it came from.
      const p = published as { from: string; to: string } | null;
      if (p) await moveNoReplace(p.to, p.from).catch((err) => this.log.error(`cannot undo restore ${p.to} -> ${p.from}: ${String(err)}`));
      throw e;
    }
  }

  /**
   * Upserts the row for one restored disk entry (and recursively its children): the manifest id
   * is reused if its row is tombstoned or gone; a currently live id gets a new id instead.
   */
  private async place(
    tx: Tx, user: IndexUser, d: DiskNode, rel: string, sub: string, parentId: string | null,
    manifest: Map<string, TrashManifestEntry>, rows: Item[],
  ): Promise<void> {
    const m = manifest.get(sub);
    const wanted = m && m.type === d.type ? m : undefined;
    const existing = wanted ? await tx.item.findUnique({ where: { id: wanted.id } }) : null;
    const revivable = existing !== null && existing.ownerId === user.id && existing.deletedAt !== null && existing.type === d.type;
    const isFile = d.type === 'file';
    let contentHash: string | null = null;
    if (isFile) {
      const sameAsManifest = wanted?.size !== undefined && wanted.mtime !== undefined && BigInt(wanted.size) === d.size && new Date(wanted.mtime).getTime() === d.mtime.getTime();
      if (sameAsManifest) contentHash = wanted?.contentHash ?? null;
      else if (revivable && existing.size === d.size && existing.mtime.getTime() === d.mtime.getTime()) contentHash = existing.contentHash;
    }
    const data = {
      parentId, type: d.type, name: d.name, nameKey: nameKey(d.name), path: rel,
      size: isFile ? d.size : 0n, mtime: d.mtime, ino: d.ino, dev: d.dev, contentHash,
    };
    let row: Item;
    if (revivable) {
      row = await tx.item.update({ where: { id: existing.id }, data: { ...data, deletedAt: null, ...(isFile ? { version: { increment: 1 } } : {}) } });
    } else if (wanted && existing === null) {
      row = await tx.item.create({ data: { id: wanted.id, ownerId: user.id, ...data } });
    } else {
      row = await tx.item.create({ data: { ownerId: user.id, ...data } });
    }
    rows.push(row);
    if (d.type !== 'folder') return;
    for (const child of await readDisk(this.abs(user, rel), (msg) => this.log.warn(msg))) {
      await this.place(tx, user, child, joinRel(rel, child.name), sub === '' ? child.name : `${sub}/${child.name}`, row.id, manifest, rows);
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

  /** Deletes entries of all users whose `expiresAt` lies before `now` (entries without one never expire). */
  async expire(now = new Date()): Promise<number> {
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

  /** Removes the stored content of deleted rows (after the background move to /meta has settled). */
  private async purge(entries: TrashEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // A move still queued would otherwise re-create the store path after we removed it.
    await this.files.pendingTrash();
    for (const e of entries) await this.removeStore(e);
  }

  /** Removes `/meta/trash/<id>` (only paths inside the trash root are ever touched). */
  private async removeStore(entry: TrashEntry): Promise<void> {
    const trashRoot = path.resolve(this.config.metaRoot, 'trash');
    const dir = this.trashDir(entry.id);
    const store = path.resolve(entry.storePath);
    const target = path.dirname(store) === dir ? dir : store;
    if (!target.startsWith(trashRoot + path.sep)) {
      this.log.warn(`not removing trash content outside ${trashRoot}: ${target}`);
      return;
    }
    await rm(target, { recursive: true, force: true }).catch((e) => this.log.error(`cannot remove ${target}: ${String(e)}`));
  }
}
