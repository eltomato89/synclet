import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Item, VersionSource } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey, tempName, TRASH_STAGING_PREFIX, trashStagingName, validateName } from '../common/names';
import { absPath, joinRel, parentRel as parentOf, realpathInside } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexSpace } from '../common/types';
import { ItemStore } from '../journal/item-store';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { SpacesRepo } from '../spaces/spaces.repo';
import { PreparedVersion, StaleVersionError, VersionContentReplacer, VersionsService } from '../versions/versions.service';
import { rethrowStorageError } from '../common/storage-errors';
import { copyNoReplace, copyTree, linkNoReplace, moveAcrossFs, moveNoReplace, replaceAtomic, statEntry } from './fs-ops';

export type OnConflict = 'fail' | 'rename';

export function itemEtag(item: Item): string {
  return item.type === 'file' ? `v${item.version}` : `t${item.updatedAt.getTime()}`;
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const isEexist = (e: unknown) => errno(e) === 'EEXIST';
/** commitSpaceMove: the spaces are on different file systems, nothing was changed. */
const CROSS_DEVICE = Symbol('cross-device');

/** Disk errors that mean "the parent/source vanished on the host and is not indexed yet". */
function mapMissing(e: unknown, what: string): unknown {
  return errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR' ? new SyncError('not_found', `${what} missing on disk`) : e;
}

/**
 * Keeps an early client abort from becoming an unhandled 'error' event while the body is not
 * piped yet (we validate the parent first). `pipeline` still sees the stream as errored.
 */
function guardBody(body: Readable) {
  body.on('error', () => {});
}

const STAGED_TRASH = /^\.synclet-trash-([0-9a-f]{32})$/;
/** Written to /meta/staging/<trashId>.json before an entry is vacated, so a crash before commit can be undone. */
interface TrashIntent {
  spaceId: string; itemId: string; originalRel: string; name: string; type: 'folder' | 'file';
  /** Intents written before Phase 4 carry the user id (= personal space id) instead. */
  userId?: string;
}

async function sizeOf(abs: string): Promise<bigint> {
  const st = await lstat(abs, { bigint: true });
  if (!st.isDirectory()) return st.isFile() ? st.size : 0n;
  let total = 0n;
  for (const n of await readdir(abs)) total += await sizeOf(path.join(abs, n));
  return total;
}

/**
 * One row of a TrashEntry manifest: enough to restore the subtree with its original IDs even
 * after the tombstones were purged. Old entries carry only `{ id, type, path }`.
 */
export type TrashManifestEntry = {
  id: string; type: 'folder' | 'file'; path: string;
  name?: string; mtime?: string; size?: number; contentHash?: string | null;
};

function manifestEntry(i: Item): TrashManifestEntry {
  return { id: i.id, type: i.type, path: i.path, name: i.name, mtime: i.mtime.toISOString(), size: Number(i.size), contentHash: i.contentHash };
}

const uuidFromHex = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

@Injectable()
export class FilesService implements OnModuleDestroy, VersionContentReplacer {
  private readonly log = new Logger(FilesService.name);
  /** Serialized background moves of committed deletes from their staging entry to /meta/trash. */
  private trashQueue: Promise<void> = Promise.resolve();
  /**
   * Test seams of moves between spaces: the same-file-system rename (replace it to simulate EXDEV)
   * and a hook between the unlocked copy and its locked publication.
   */
  readonly moveOps: { moveNoReplace: (src: string, dst: string) => Promise<void>; afterCopy?: () => Promise<void> } = { moveNoReplace };

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly versions: VersionsService,
    private readonly spaces: SpacesRepo,
  ) {
    versions.attachReplacer(this);
  }

  private abs(space: IndexSpace, rel: string) { return absPath(space.rootPath, rel); }

  private root(space: IndexSpace) { return space.rootPath; }

  /**
   * Asserts that folder `rel` is a chain of real directories below the space root: no symlinked
   * ancestor (e.g. `Docs -> ../bob` swapped in after indexing), nothing resolving outside the root.
   * Called under the space lock right before every disk mutation, so nothing is touched otherwise.
   */
  async assertRealDir(space: IndexSpace, rel: string): Promise<void> {
    const root = this.root(space);
    let cur = root;
    for (const seg of rel === '' ? [] : rel.split('/')) {
      cur = path.join(cur, seg);
      const st = await lstat(cur).catch(() => null);
      if (!st?.isDirectory()) throw new SyncError('not_found', 'folder missing on disk or not a real folder');
    }
    try {
      await realpathInside(cur, root);
    } catch {
      throw new SyncError('not_found', 'path escapes the space root');
    }
  }

  /** Checks an indexed entry before mutating it: real parent chain, and still the indexed type. */
  private async entryOnDisk(space: IndexSpace, item: Item): Promise<'ok' | 'missing'> {
    await this.assertRealDir(space, parentOf(item.path));
    const st = await lstat(this.abs(space, item.path)).catch((e) => (errno(e) === 'ENOENT' ? null : Promise.reject(e)));
    if (!st) return 'missing';
    if (item.type === 'folder' ? !st.isDirectory() : !st.isFile()) throw new SyncError('not_found', 'entry on disk is not the indexed type');
    return 'ok';
  }

  private checkName(raw: string): string {
    const err = validateName(raw);
    if (err) throw new SyncError('invalid_name', `invalid name (${err})`);
    return raw.normalize('NFC');
  }

  private async parentPath(tx: Tx, space: IndexSpace, parentId: string | null): Promise<string> {
    if (parentId === null) return '';
    const p = await this.store.getLive(tx, space.id, parentId);
    if (!p) throw new SyncError('not_found', 'parent not found');
    if (p.type !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    return p.path;
  }

  private async takenKeys(tx: Tx, space: IndexSpace, parentId: string | null, excludeId?: string) {
    const sibs = (await this.store.liveChildren(tx, space.id, parentId)).filter((s) => s.id !== excludeId);
    return { sibs, keys: new Set(sibs.map((s) => s.nameKey)) };
  }

  /** Journals the items plus same-key siblings (their display names may change). */
  private async announce(tx: Tx, space: IndexSpace, items: Item[], extra: { parentId: string | null; key: string }[] = []) {
    const ids = new Set(items.map((i) => i.id));
    const sibs: Item[] = [];
    for (const { parentId, key } of [...items.map((i) => ({ parentId: i.parentId, key: i.nameKey })), ...extra]) {
      sibs.push(...(await this.store.sameKeySiblings(tx, space.id, parentId, [key], ids)));
    }
    await this.journal.record(tx, space.id, [...items, ...sibs], 'upsert');
  }

  async createFolder(space: IndexSpace, parentId: string | null, rawName: string, onConflict: OnConflict = 'fail'): Promise<Item> {
    const desired = this.checkName(rawName);
    let created: string | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, space.id);
        const parentRel = await this.parentPath(tx, space, parentId);
        const { sibs, keys } = await this.takenKeys(tx, space, parentId);
        await this.assertRealDir(space, parentRel);
        let name = desired;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) {
            if (onConflict === 'fail') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
            name = freeName(desired, keys, true);
          }
          try {
            await mkdir(this.abs(space, joinRel(parentRel, name)));
            created = this.abs(space, joinRel(parentRel, name));
            break;
          } catch (e) {
            if (!isEexist(e) || attempt > 100) throw mapMissing(e, 'parent folder');
            if (onConflict === 'fail') throw new SyncError('name_conflict', 'exists on disk');
            keys.add(nameKey(name)); // unindexed entry on disk – try the next free name
          }
        }
        const rel = joinRel(parentRel, name);
        const st = await statEntry(this.abs(space, rel));
        const item = await tx.item.create({
          data: { spaceId: space.id, parentId, type: 'folder', name, nameKey: nameKey(name), path: rel, size: 0n, mtime: st.mtime, ino: st.ino, dev: st.dev },
        });
        await this.announce(tx, space, [item]);
        return item;
      }, TX_OPTS);
    } catch (e) {
      // Rolled back: take the (still empty) folder away again so the indexer does not adopt it.
      if (created) await rmdir(created).catch(() => {});
      throw e;
    }
  }

  /** Streams the body into a temp file in the space root (same file system as the target). */
  private async receive(space: IndexSpace, body: Readable, modifiedAt?: Date | null, max = this.config.maxUploadBytes): Promise<{ tmp: string; size: bigint; sha256: string }> {
    const tmp = path.join(this.root(space), tempName(randomBytes(8).toString('hex')));
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) { cb(Object.assign(new Error('too large'), { tooLarge: true })); return; }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      // `flush` fsyncs before close, so a published file is durable.
      await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx', mode: 0o666, flush: true }));
      if (modifiedAt) await utimes(tmp, modifiedAt, modifiedAt);
    } catch (e) {
      await rm(tmp, { force: true });
      if ((e as { tooLarge?: boolean }).tooLarge) throw new SyncError('too_large');
      rethrowStorageError(e);
    }
    return { tmp, size: BigInt(size), sha256: hash.digest('hex') };
  }

  async upload(space: IndexSpace, parentId: string | null, rawName: string, body: Readable, opts: { onConflict?: OnConflict; modifiedAt?: Date | null }): Promise<Item> {
    guardBody(body);
    const desired = this.checkName(rawName);
    await this.prisma.$transaction((tx) => this.parentPath(tx, space, parentId)); // fail fast before streaming
    const { tmp, sha256 } = await this.receive(space, body, opts.modifiedAt);
    try {
      try {
        return await this.publishNew(space, parentId, desired, tmp, sha256, opts.onConflict ?? 'fail');
      } finally {
        await rm(tmp, { force: true });
      }
    } catch (e) {
      rethrowStorageError(e);
    }
  }

  /** Creates a file from a received temp file (hard link, never replacing). The caller removes `tmp`. */
  private async publishNew(space: IndexSpace, parentId: string | null, desired: string, tmp: string, sha256: string, onConflict: OnConflict): Promise<Item> {
    let published: { abs: string; ino: bigint } | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, space.id);
        const parentRel = await this.parentPath(tx, space, parentId);
        const { sibs, keys } = await this.takenKeys(tx, space, parentId);
        await this.assertRealDir(space, parentRel);
        let name = desired;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) {
            if (onConflict !== 'rename') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
            name = freeName(desired, keys, false);
          }
          try {
            await linkNoReplace(tmp, this.abs(space, joinRel(parentRel, name)));
            break;
          } catch (e) {
            if (!isEexist(e) || attempt > 100) throw mapMissing(e, 'parent folder');
            if (onConflict !== 'rename') throw new SyncError('name_conflict', 'exists on disk');
            keys.add(nameKey(name)); // unindexed entry on disk – try the next free name
          }
        }
        const rel = joinRel(parentRel, name);
        const st = await statEntry(this.abs(space, rel));
        published = { abs: this.abs(space, rel), ino: st.ino };
        const item = await tx.item.create({
          data: { spaceId: space.id, parentId, type: 'file', name, nameKey: nameKey(name), path: rel, size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256 },
        });
        await this.announce(tx, space, [item]);
        return item;
      }, TX_OPTS);
    } catch (e) {
      // Rolled back after publishing: withdraw our file (only if it is still ours).
      const p = published as { abs: string; ino: bigint } | null;
      if (p) {
        const now = await statEntry(p.abs).catch(() => null);
        if (now && now.ino === p.ino) await unlink(p.abs).catch(() => {});
      }
      rethrowStorageError(e);
    }
  }

  /** New file from a template (e.g. an empty office document); a taken name gets a free suffix. */
  async createFromTemplate(space: IndexSpace, parentId: string | null, rawName: string, templatePath: string): Promise<Item> {
    return this.upload(space, parentId, rawName, createReadStream(templatePath), { onConflict: 'rename' });
  }

  /**
   * Under the space lock: the live file row and its absolute path. A host edit that is not indexed
   * yet is recorded as a new version first (`changedOnDisk`), so it is never overwritten blindly.
   */
  private async lockedFile(tx: Tx, space: IndexSpace, itemId: string): Promise<{ item: Item; target: string; changedOnDisk: boolean }> {
    const item = await this.store.getLive(tx, space.id, itemId);
    if (!item || item.type !== 'file') throw new SyncError('not_found');
    const target = this.abs(space, item.path);
    // Deleted (or replaced by a folder) on the host but not indexed yet: never resurrect it
    // blindly; the indexer will journal the delete.
    if ((await this.entryOnDisk(space, item)) === 'missing') throw new SyncError('not_found', 'file missing on disk');
    const disk = await statEntry(target);
    // A new inode with equal size+mtime is an atomic save (temp + rename) on the host. Our own
    // writes store the inode they produce, so this never fires for them.
    const inoChanged = item.ino !== null && (disk.ino !== item.ino || disk.dev !== item.dev);
    if (inoChanged || disk.size !== item.size || disk.mtime.getTime() !== item.mtime.getTime()) {
      const fresh = await tx.item.update({
        where: { id: item.id },
        data: { size: disk.size, mtime: disk.mtime, ino: disk.ino, dev: disk.dev, contentHash: null, version: { increment: 1 }, officeKey: null },
      });
      await this.journal.record(tx, space.id, [fresh], 'upsert');
      return { item: fresh, target, changedOnDisk: true };
    }
    return { item, target, changedOnDisk: false };
  }

  /**
   * Runs one replace attempt with the current content's version prepared outside the space lock
   * (a cross-file-system copy never holds the lock). If the file changed between preparing and
   * the locked commit, the preparation is discarded and redone once; a second change is a 412.
   * Prepared temp files (and a published version whose transaction did not commit) are removed.
   */
  private async withPreparedVersion<T>(space: IndexSpace, itemId: string, attempt: (prepared: PreparedVersion | null) => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      const prepared = await this.versions.prepare(space, itemId);
      try {
        const out = await attempt(prepared);
        if (prepared) prepared.committed = true;
        return out;
      } catch (e) {
        // Renamed over the file but not committed (or the commit's outcome is unknown): the
        // version file must survive and be recorded.
        if (prepared?.replaced) await this.versions.recoverRow(prepared);
        if (!(e instanceof StaleVersionError)) throw e;
        if (i >= 1) {
          const row = await this.prisma.item.findFirst({ where: { id: itemId, spaceId: space.id, deletedAt: null } });
          throw new SyncError('conflict', 'file changed while its version was captured', row ?? undefined);
        }
      } finally {
        await this.versions.discard(prepared);
      }
    }
  }

  /** `tmp`, or a copy of it next to `target` when a mount point lies in between (so the final rename keeps the inode). */
  private async nearTarget(tmp: string, target: string): Promise<string> {
    const [a, b] = await Promise.all([lstat(tmp, { bigint: true }), lstat(path.dirname(target), { bigint: true })]);
    if (a.dev === b.dev) return tmp;
    const near = path.join(path.dirname(target), tempName(randomBytes(8).toString('hex')));
    await copyNoReplace(tmp, near);
    return near;
  }

  /**
   * Under the space lock: keeps the current content as a version (when versions are on; a failed
   * or stale capture throws and nothing is replaced), writes the row (version + 1) and journal,
   * and only then – as the very last step – renames the new content over the file. Any failure or
   * transaction timeout before that leaves the current file untouched and rolls back the rows.
   */
  private async commitReplace(
    tx: Tx, space: IndexSpace, item: Item, target: string, tmp: string, sha256: string,
    source: VersionSource, opts: { officeKey: string | null; by?: string; prepared?: PreparedVersion | null },
  ): Promise<Item> {
    await this.versions.capture(tx, space, item, target, source, opts.by, opts.prepared);
    const src = await this.nearTarget(tmp, target);
    try {
      // rename keeps inode, size and mtime: the row describes the file as it will be published.
      const st = await statEntry(src);
      const updated = await tx.item.update({
        where: { id: item.id },
        data: { size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256, version: { increment: 1 }, officeKey: opts.officeKey },
      });
      await this.journal.record(tx, space.id, [updated], 'upsert');
      // From here the published version may be the only copy of the previous content.
      if (opts.prepared) opts.prepared.replaced = true;
      try {
        await replaceAtomic(src, target);
      } catch (e) {
        if (opts.prepared) opts.prepared.replaced = false; // rename(2) failed: nothing was replaced
        throw e;
      }
      return updated;
    } finally {
      if (src !== tmp) await rm(src, { force: true });
    }
  }

  async replaceContent(space: IndexSpace, itemId: string, body: Readable, opts: { ifMatchVersion: number | null; modifiedAt?: Date | null; by?: string }): Promise<Item> {
    return this.replaceFrom(space, itemId, body, { ...opts, source: 'api', maxBytes: this.config.maxUploadBytes });
  }

  /**
   * Version restore (VersionsService.restore): replaces the content with the version's bytes via
   * the same path as a PUT with `If-Match: *`; the current content is captured first (`restore`).
   * Not limited by the upload size (the bytes were this file's content before). mtime = now.
   */
  async restoreFromVersion(space: IndexSpace, itemId: string, body: Readable, by?: string): Promise<Item> {
    return this.replaceFrom(space, itemId, body, { ifMatchVersion: null, modifiedAt: null, source: 'restore', maxBytes: Number.POSITIVE_INFINITY, by });
  }

  /** PUT content and version restore: receive into a temp, then lockedFile + commitReplace under the space lock. */
  private async replaceFrom(
    space: IndexSpace, itemId: string, body: Readable,
    opts: { ifMatchVersion: number | null; modifiedAt?: Date | null; source: VersionSource; maxBytes: number; by?: string },
  ): Promise<Item> {
    guardBody(body);
    const pre = await this.prisma.item.findFirst({ where: { id: itemId, spaceId: space.id, deletedAt: null } });
    if (!pre || pre.type !== 'file') throw new SyncError('not_found');
    // ifMatchVersion null = `If-Match: *` (any current version).
    if (opts.ifMatchVersion !== null && pre.version !== opts.ifMatchVersion) throw new SyncError('conflict', 'version mismatch', pre);
    const { tmp, sha256 } = await this.receive(space, body, opts.modifiedAt, opts.maxBytes);
    try {
      // The transaction returns the conflict instead of throwing, so the recorded
      // external version is committed before the 412 goes out.
      const outcome = await this.withPreparedVersion(space, itemId, (prepared) => this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, space.id);
        const { item, target, changedOnDisk } = await this.lockedFile(tx, space, itemId);
        // Edited on the host but not yet indexed: that version is recorded, report the conflict.
        if (changedOnDisk) return { conflict: item, reason: 'file changed on disk' } as const;
        if (opts.ifMatchVersion !== null && item.version !== opts.ifMatchVersion) return { conflict: item, reason: 'version mismatch' } as const;
        return { ok: await this.commitReplace(tx, space, item, target, tmp, sha256, opts.source, { officeKey: null, by: opts.by, prepared }) } as const;
      }, TX_OPTS));
      if ('conflict' in outcome) throw new SyncError('conflict', outcome.reason, outcome.conflict);
      return outcome.ok;
    } catch (e) {
      rethrowStorageError(e); // the temp file is removed by `finally` right after
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Saves content coming back from the office Document Server for an editing session `key` that
   * started on `baseVersion`. Replaces the file (version source `office`, `officeKey = key`) unless
   * it was changed meanwhile by anything but this same session (sync client, host, another
   * session): then the content goes into a sibling conflict copy and the original stays untouched.
   * Repeated saves of one session (forcesave, then the final save) overwrite each other.
   * A file that is gone (trashed, deleted through Synclet or on the host and indexed) never loses
   * the edits either: they become a conflict copy in the original parent folder, or in the space
   * root when that folder is gone too (`fallbackName` when even the row was purged). A live row
   * whose entry is briefly missing on disk (the middle of a host editor's delete+rename save)
   * gives `retry`: the Document Server is told to send the save again later.
   */
  async saveOfficeContent(
    space: IndexSpace, itemId: string, body: Readable,
    opts: { key: string; baseVersion: number; by?: string; conflictName: (name: string) => string; fallbackName: string },
  ): Promise<{ outcome: 'replaced' | 'conflict' | 'orphaned'; item: Item } | { outcome: 'retry' }> {
    guardBody(body);
    const { tmp, sha256 } = await this.receive(space, body);
    try {
      const decided = await this.withPreparedVersion(space, itemId, (prepared) => this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, space.id);
        const live = await this.store.getLive(tx, space.id, itemId);
        if (!live || live.type !== 'file') {
          const row = live ?? (await tx.item.findFirst({ where: { id: itemId, spaceId: space.id } }));
          return { outcome: 'gone', row: row?.type === 'file' ? row : null } as const;
        }
        let cur: Awaited<ReturnType<FilesService['lockedFile']>>;
        try {
          cur = await this.lockedFile(tx, space, itemId);
        } catch (e) {
          // Live row, entry missing on disk: let the indexer settle and have the save retried.
          if (e instanceof SyncError && e.code === 'not_found') return { outcome: 'retry' } as const;
          throw e;
        }
        const { item, target } = cur;
        if (item.version !== opts.baseVersion && item.officeKey !== opts.key) return { outcome: 'conflict', item } as const;
        return { outcome: 'replaced', item: await this.commitReplace(tx, space, item, target, tmp, sha256, 'office', { officeKey: opts.key, by: opts.by, prepared }) } as const;
      }, TX_OPTS));
      if (decided.outcome === 'replaced' || decided.outcome === 'retry') return decided;
      if (decided.outcome === 'conflict') {
        const copy = await this.publishNew(space, decided.item.parentId, opts.conflictName(decided.item.name), tmp, sha256, 'rename');
        return { outcome: 'conflict', item: copy };
      }
      const name = opts.conflictName(decided.row?.name ?? opts.fallbackName);
      const parentId = decided.row?.parentId ?? null;
      if (parentId !== null) {
        try {
          return { outcome: 'orphaned', item: await this.publishNew(space, parentId, name, tmp, sha256, 'rename') };
        } catch (e) {
          // The original folder is gone (trashed, deleted, missing on disk): use the space root.
          if (!(e instanceof SyncError && (e.code === 'not_found' || e.code === 'invalid_request'))) throw e;
        }
      }
      return { outcome: 'orphaned', item: await this.publishNew(space, null, name, tmp, sha256, 'rename') };
    } catch (e) {
      rethrowStorageError(e); // the temp file is removed by `finally` right after
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /**
   * Renames and/or moves an item. With `targetSpace` other than `space`, `parentId` (null = its root)
   * is in that space and the item moves there (moveToSpace); the caller checked write on both.
   */
  async update(space: IndexSpace, itemId: string, patch: { name?: string; parentId?: string | null; targetSpace?: IndexSpace }, opts: { ifMatchEtag?: string } = {}): Promise<Item> {
    const newName = patch.name === undefined ? undefined : this.checkName(patch.name);
    if (patch.targetSpace && patch.targetSpace.id !== space.id) {
      return this.moveToSpace(space, patch.targetSpace, itemId, patch.parentId ?? null, newName, opts);
    }
    let moved: { from: string; to: string } | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, space.id);
        const item = await this.store.getLive(tx, space.id, itemId);
        if (!item) throw new SyncError('not_found');
        if (opts.ifMatchEtag && opts.ifMatchEtag !== itemEtag(item)) throw new SyncError('conflict', 'etag mismatch', item);
        const targetParent = patch.parentId === undefined ? item.parentId : patch.parentId;
        const name = newName ?? item.name;
        if (targetParent === item.parentId && name === item.name) return item;
        const parentRel = await this.parentPath(tx, space, targetParent);
        if (item.type === 'folder' && (parentRel === item.path || parentRel.startsWith(item.path + '/'))) {
          throw new SyncError('invalid_move', 'cannot move a folder into itself');
        }
        const { sibs, keys } = await this.takenKeys(tx, space, targetParent, item.id);
        if (keys.has(nameKey(name))) throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
        if ((await this.entryOnDisk(space, item)) === 'missing') throw new SyncError('not_found', 'entry missing on disk');
        await this.assertRealDir(space, parentRel);
        const rel = joinRel(parentRel, name);
        const from = this.abs(space, item.path);
        const to = this.abs(space, rel);
        try {
          await moveNoReplace(from, to);
          moved = { from, to };
        } catch (e) {
          if (isEexist(e)) throw new SyncError('name_conflict', 'exists on disk');
          throw mapMissing(e, 'item or target folder');
        }
        const updated = await tx.item.update({ where: { id: item.id }, data: { parentId: targetParent, name, nameKey: nameKey(name), path: rel } });
        if (item.type === 'folder') await this.store.rewritePrefix(tx, space.id, item.path, rel);
        await this.announce(tx, space, [updated], [{ parentId: item.parentId, key: item.nameKey }]);
        return updated;
      }, TX_OPTS);
    } catch (e) {
      // Rolled back after the rename: put the entry back where the DB still expects it.
      const m = moved as { from: string; to: string } | null;
      if (m) await moveNoReplace(m.to, m.from).catch((err) => this.log.error(`cannot undo move ${m.to} -> ${m.from}: ${String(err)}`));
      throw e;
    }
  }

  /**
   * Moves an item (with its subtree) into another space, keeping its id. On one file system it is a
   * rename under both space locks (taken in ascending id order, so a concurrent move the other way
   * cannot deadlock). Across file systems (EXDEV: /data, /teams and /storage are separate mounts)
   * the tree is first copied to an ignored temp entry in the target root *without* any lock, then a
   * short locked transaction checks that the source is unchanged since the copy started (else 409
   * `conflict`, nothing moved), publishes the copy by rename, stages the source under an ignored
   * name and commits; the staged source is removed after commit. Rows get the new spaceId, paths and
   * (after a copy) inodes; versions and share links follow the items; the source journal records a
   * `delete`, the target journal an `upsert` of the subtree.
   */
  private async moveToSpace(src: IndexSpace, dst: IndexSpace, itemId: string, targetParent: string | null, newName: string | undefined, opts: { ifMatchEtag?: string }): Promise<Item> {
    const fast = await this.commitSpaceMove(src, dst, itemId, targetParent, newName, opts, null);
    if (fast !== CROSS_DEVICE) return fast;
    // Snapshot first, then copy: any change of the subtree after this point fails the verification.
    const pre = await this.prisma.$transaction(async (tx) => {
      const item = await this.store.getLive(tx, src.id, itemId);
      if (!item) throw new SyncError('not_found');
      return { item, snap: await this.subtreeSnapshot(tx, src, item) };
    }, TX_OPTS);
    const tmp = path.join(dst.rootPath, tempName(randomBytes(8).toString('hex')));
    try {
      try {
        await copyTree(this.abs(src, pre.item.path), tmp);
      } catch (e) {
        rethrowStorageError(mapMissing(e, 'item'));
      }
      await this.moveOps.afterCopy?.();
      const out = await this.commitSpaceMove(src, dst, itemId, targetParent, newName, opts, { tmp, snap: pre.snap });
      if (out === CROSS_DEVICE) throw new Error('unexpected cross-device move');
      return out;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch((e) => this.log.error(`cannot remove move copy ${tmp}: ${String(e)}`));
    }
  }

  /**
   * The locked part of a move between spaces. `copy` null: rename the entry (returns CROSS_DEVICE
   * when the spaces are on different file systems, nothing changed). With `copy`: verify the source
   * against the snapshot, publish `copy.tmp` at the target, stage the source; the staged source is
   * removed after commit. Any failure before commit puts everything back.
   */
  private async commitSpaceMove(
    src: IndexSpace, dst: IndexSpace, itemId: string, targetParent: string | null, newName: string | undefined,
    opts: { ifMatchEtag?: string }, copy: { tmp: string; snap: string } | null,
  ): Promise<Item | typeof CROSS_DEVICE> {
    let renamed: { from: string; to: string } | null = null;
    let published: { tmp: string; to: string } | null = null;
    let staged: { from: string; at: string } | null = null;
    const versionMoves: { from: string; to: string }[] = [];
    let result: Item | typeof CROSS_DEVICE;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        for (const id of [src.id, dst.id].sort()) await this.journal.lockSpace(tx, id);
        const item = await this.store.getLive(tx, src.id, itemId);
        if (!item) throw new SyncError('not_found');
        if (copy && (await this.subtreeSnapshot(tx, src, item)) !== copy.snap) {
          throw new SyncError('conflict', 'changed while being moved, try again', item, 409);
        }
        if (opts.ifMatchEtag && opts.ifMatchEtag !== itemEtag(item)) throw new SyncError('conflict', 'etag mismatch', item);
        const name = newName ?? item.name;
        const parentRel = await this.parentPath(tx, dst, targetParent);
        const { sibs, keys } = await this.takenKeys(tx, dst, targetParent);
        if (keys.has(nameKey(name))) throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
        if ((await this.entryOnDisk(src, item)) === 'missing') throw new SyncError('not_found', 'entry missing on disk');
        await this.assertRealDir(dst, parentRel);
        const rel = joinRel(parentRel, name);
        const from = this.abs(src, item.path);
        const to = this.abs(dst, rel);
        try {
          if (!copy) {
            await this.moveOps.moveNoReplace(from, to);
            renamed = { from, to };
          } else {
            await moveNoReplace(copy.tmp, to); // same file system: the temp copy lives in the target root
            published = { tmp: copy.tmp, to };
            const at = path.join(src.rootPath, tempName(randomBytes(8).toString('hex')));
            await moveAcrossFs(from, at); // a rename; ignored by the indexer, removed at boot after a crash
            staged = { from, at };
          }
        } catch (e) {
          if (!copy && errno(e) === 'EXDEV') return CROSS_DEVICE;
          if (isEexist(e)) throw new SyncError('name_conflict', 'exists on disk');
          throw mapMissing(e, 'item or target folder');
        }
        const subtree = item.type === 'folder' ? [item, ...(await this.store.liveDescendants(tx, src.id, item.path))] : [item];
        const updated = await tx.item.update({ where: { id: item.id }, data: { spaceId: dst.id, parentId: targetParent, name, nameKey: nameKey(name), path: rel } });
        if (item.type === 'folder') {
          await tx.$executeRaw`
            UPDATE "Item" SET "spaceId" = ${dst.id}::uuid, path = ${rel} || substring(path FROM char_length(${item.path}) + 1), "updatedAt" = now()
            WHERE "spaceId" = ${src.id}::uuid AND "deletedAt" IS NULL
            AND left(path, char_length(${item.path}) + 1) = ${item.path} || '/'`;
        }
        let arrived = item.type === 'folder' ? [updated, ...(await this.store.liveDescendants(tx, dst.id, rel))] : [updated];
        // A copy has new inodes (and possibly coarser mtimes): without this the next write would
        // take the rows for a host edit (version + 1, 412) and If-Range would never match.
        if (copy) arrived = await this.refreshStats(tx, dst, arrived);
        const ids = subtree.map((i) => i.id);
        await tx.shareLink.updateMany({ where: { itemId: { in: ids }, spaceId: src.id }, data: { spaceId: dst.id } });
        await this.moveVersions(tx, src, dst, subtree.filter((i) => i.type === 'file').map((i) => i.id), versionMoves);
        // Source: the subtree is gone (+ same-key siblings whose display names may change).
        await this.journal.record(tx, src.id, subtree, 'delete');
        await this.journal.record(tx, src.id, await this.store.sameKeySiblings(tx, src.id, item.parentId, [item.nameKey], new Set([item.id])), 'upsert');
        // Target: the whole subtree is new.
        await this.announce(tx, dst, arrived);
        return arrived[0];
      }, TX_OPTS);
    } catch (e) {
      for (const d of versionMoves.reverse()) {
        await rename(d.to, d.from).catch((err) => this.log.error(`cannot undo version move ${d.to} -> ${d.from}: ${String(err)}`));
      }
      const r = renamed as { from: string; to: string } | null;
      if (r) await moveAcrossFs(r.to, r.from, this.moveOps.moveNoReplace).catch((err) => this.log.error(`cannot undo move ${r.to} -> ${r.from}: ${String(err)}`));
      const s = staged as { from: string; at: string } | null;
      if (s) await moveAcrossFs(s.at, s.from).catch((err) => this.log.error(`cannot restore ${s.at} -> ${s.from}: ${String(err)}`));
      // Back to the temp name: the caller removes it.
      const p = published as { tmp: string; to: string } | null;
      if (p) await moveNoReplace(p.to, p.tmp).catch((err) => this.log.error(`cannot withdraw move copy ${p.to}: ${String(err)}`));
      throw e;
    }
    const s = staged as { from: string; at: string } | null;
    if (s) await rm(s.at, { recursive: true, force: true }).catch((e) => this.log.error(`cannot remove moved source ${s.at}: ${String(e)}`));
    return result;
  }

  /**
   * What a cross-file-system move must find unchanged before it publishes its copy: the live rows of
   * the subtree (id, path, version, size, mtime) and the entries on disk (type, size, mtime, inode).
   */
  private async subtreeSnapshot(tx: Tx, space: IndexSpace, item: Item): Promise<string> {
    const rows = item.type === 'folder' ? [item, ...(await this.store.liveDescendants(tx, space.id, item.path))] : [item];
    const db = rows.map((r) => `${r.id}|${r.path}|${r.version}|${r.size}|${r.mtime.getTime()}`).sort();
    const disk: string[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      const st = await lstat(abs, { bigint: true }).catch(() => null);
      if (!st) { disk.push(`${rel}|missing`); return; }
      const kind = st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o';
      disk.push(`${rel}|${kind}|${kind === 'f' ? st.size : 0n}|${st.mtimeNs}|${st.ino}`);
      if (kind === 'd') for (const n of (await readdir(abs)).sort()) await walk(path.join(abs, n), `${rel}/${n}`);
    };
    await walk(this.abs(space, item.path), '');
    return JSON.stringify([db, disk.sort()]);
  }

  /** Re-reads inode, device and mtime of moved rows from disk (after a copy). Returns the updated rows. */
  private async refreshStats(tx: Tx, space: IndexSpace, rows: Item[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const r of rows) {
      const st = await statEntry(this.abs(space, r.path)).catch(() => null);
      out.push(st ? await tx.item.update({ where: { id: r.id }, data: { ino: st.ino, dev: st.dev, mtime: st.mtime } }) : r);
    }
    return out;
  }

  /**
   * Moves the stored versions of `fileIds` from `<meta>/versions/<src>/<item>` to `<dst>/<item>`
   * (same file system) and updates their rows. An existing target folder (left over from an earlier
   * move) is merged, never overwritten: a taken file name gets a unique suffix. Every rename is
   * pushed to `done` for an undo.
   */
  private async moveVersions(tx: Tx, src: IndexSpace, dst: IndexSpace, fileIds: string[], done: { from: string; to: string }[]): Promise<void> {
    if (fileIds.length === 0) return;
    const rows = await tx.fileVersion.findMany({ where: { spaceId: src.id, itemId: { in: fileIds } }, select: { id: true, itemId: true, storePath: true } });
    if (rows.length === 0) return;
    const store = path.resolve(this.config.metaRoot, 'versions');
    const exists = (p: string) => lstat(p).then(() => true, () => false);
    for (const itemId of [...new Set(rows.map((r) => r.itemId))]) {
      const from = path.join(store, src.id, itemId);
      const to = path.join(store, dst.id, itemId);
      /** Old absolute path → new one, for the rows. */
      const moved = new Map<string, string>();
      if (await exists(from)) {
        await mkdir(path.dirname(to), { recursive: true });
        if (!(await exists(to))) {
          await rename(from, to);
          done.push({ from, to });
          for (const n of await readdir(to)) moved.set(path.join(from, n), path.join(to, n));
        } else {
          for (const n of await readdir(from)) {
            let target = path.join(to, n);
            while (await exists(target)) target = path.join(to, `${n}.${randomBytes(4).toString('hex')}`);
            await rename(path.join(from, n), target);
            done.push({ from: path.join(from, n), to: target });
            moved.set(path.join(from, n), target);
          }
          await rmdir(from).catch(() => {});
        }
      }
      for (const r of rows.filter((x) => x.itemId === itemId)) {
        const storePath = moved.get(path.resolve(r.storePath)) ?? r.storePath;
        await tx.fileVersion.update({ where: { id: r.id }, data: { spaceId: dst.id, storePath } });
      }
    }
  }

  /**
   * Deletes an item into the trash. The entry is vacated atomically under the space lock by
   * renaming it to an ignored staging name in the space root (`.synclet-trash-<id>`, same file
   * system, so neither the indexer nor a concurrent API call can ever see it half-gone); the
   * possibly slow copy to /meta happens after commit, in the background (`pendingTrash()`).
   * A crash in between is finished by `recoverStagedTrash()` at the next start.
   */
  async remove(space: IndexSpace, itemId: string): Promise<void> {
    const trashId = randomUUID();
    const staging = path.join(this.root(space), trashStagingName(trashId));
    let staged: { from: string; storePath: string } | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, space.id);
        const item = await this.store.getLive(tx, space.id, itemId);
        if (!item) throw new SyncError('not_found');
        // Already gone on the host (not indexed yet): the delete stands, there is nothing to trash.
        if ((await this.entryOnDisk(space, item)) === 'ok') {
          const from = this.abs(space, item.path);
          await this.writeIntent(trashId, { spaceId: space.id, itemId: item.id, originalRel: item.path, name: item.name, type: item.type });
          try {
            await moveAcrossFs(from, staging); // rename; copy only if a nested mount is in between
          } catch (e) {
            await this.dropIntent(trashId);
            throw e;
          }
          staged = { from, storePath: path.join(this.config.metaRoot, 'trash', trashId, item.name) };
        }
        const gone = await this.store.tombstoneSubtree(tx, item);
        if (staged) {
          const deletedAt = new Date();
          await tx.trashEntry.create({
            data: {
              id: trashId, spaceId: space.id, itemId: item.id, type: item.type, name: item.name, originalPath: item.path,
              size: gone.reduce((s, i) => s + i.size, 0n), storePath: (staged as { storePath: string }).storePath,
              manifest: gone.map(manifestEntry), deletedAt, expiresAt: this.trashExpiry(deletedAt),
            },
          });
        }
        await this.journal.record(tx, space.id, gone, 'delete');
        const sibs = await this.store.sameKeySiblings(tx, space.id, item.parentId, [item.nameKey], new Set([item.id]));
        await this.journal.record(tx, space.id, sibs, 'upsert');
      }, TX_OPTS);
    } catch (e) {
      // Rolled back after vacating: put the entry back where the DB still expects it.
      const st = staged as { from: string } | null;
      if (st) {
        // No-replace: if the host re-created the path meanwhile, the entry stays staged with its
        // intent and the next start's recovery moves it to the trash instead.
        await moveAcrossFs(staging, st.from).then(
          () => this.dropIntent(trashId),
          (err) => this.log.error(`cannot restore ${staging} -> ${st.from}: ${String(err)}; recovery will retry at start`),
        );
      }
      throw e;
    }
    const done = staged as { storePath: string } | null;
    if (done) {
      // Committed: the response does not wait for the (cross-mount, possibly huge) copy to /meta.
      // The staged entry stays ignored by the indexer and unreachable by name via the API until
      // the move finishes; a crash meanwhile is completed by recoverStagedTrash() at the next start
      // (the TrashEntry exists), and so is a failure here (e.g. /meta briefly unavailable).
      const job = () => this.finishTrash(staging, done.storePath).then(() => this.dropIntent(trashId), (e) =>
        this.log.error(`moving ${staging} to ${done.storePath} failed, left staged for recovery: ${(e as Error).message}`));
      this.trashQueue = this.trashQueue.then(job, job);
    }
  }

  /** When a trash entry deleted at `deletedAt` expires (null = kept until deleted by hand). */
  trashExpiry(deletedAt: Date): Date | null {
    const days = this.config.trashRetentionDays;
    return days > 0 ? new Date(deletedAt.getTime() + days * 24 * 3600 * 1000) : null;
  }

  /** Resolves once all background trash moves queued so far have finished (they never reject). */
  pendingTrash(): Promise<void> {
    return this.trashQueue;
  }

  async onModuleDestroy(): Promise<void> {
    await this.trashQueue;
  }

  private intentPath(trashId: string) { return path.join(this.config.metaRoot, 'staging', `${trashId}.json`); }

  private async writeIntent(trashId: string, intent: TrashIntent): Promise<void> {
    await mkdir(path.dirname(this.intentPath(trashId)), { recursive: true });
    const fh = await open(this.intentPath(trashId), 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(intent));
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async readIntent(trashId: string): Promise<TrashIntent | null> {
    try {
      return JSON.parse(await readFile(this.intentPath(trashId), 'utf8')) as TrashIntent;
    } catch {
      return null;
    }
  }

  private async dropIntent(trashId: string): Promise<void> {
    await rm(this.intentPath(trashId), { force: true });
  }

  /** Moves a staged entry into its trash location; an existing storePath means a completed copy. */
  private async finishTrash(staging: string, storePath: string): Promise<void> {
    if (await lstat(storePath).then(() => true, () => false)) {
      await rm(staging, { recursive: true, force: true });
      return;
    }
    await mkdir(path.dirname(storePath), { recursive: true });
    await moveAcrossFs(staging, storePath);
  }

  /**
   * Finishes trash moves interrupted by a crash. For every `.synclet-trash-<id>` in a space root:
   * - TrashEntry exists (crash after commit): move it into its storePath.
   * - only the intent file exists (crash before commit, so the delete never happened): move it
   *   back to its original path if that is free, otherwise into /meta/trash/<id>/ with a new
   *   TrashEntry; the indexer reconciles the rows either way.
   * - neither: log and leave it untouched.
   * Returns the number of staged entries handled.
   */
  async recoverStagedTrash(): Promise<number> {
    let handled = 0;
    // Missing spaces too: an unreadable root simply lists nothing, and a returned mount is handled then.
    for (const row of await this.prisma.space.findMany({ select: { id: true, kind: true, rootPath: true } })) {
      if (!row.rootPath) continue; // personal root not synced yet (never after SpacesRepo init)
      const space = this.spaces.toIndexSpace(row);
      const root = space.rootPath;
      const names = await readdir(root).catch(() => [] as string[]);
      for (const name of names.filter((n) => n.startsWith(TRASH_STAGING_PREFIX))) {
        const abs = path.join(root, name);
        const m = STAGED_TRASH.exec(name);
        if (!m) {
          this.log.warn(`unexpected staging entry ${abs}; leaving it untouched`);
          continue;
        }
        const trashId = uuidFromHex(m[1]);
        try {
          const entry = await this.prisma.trashEntry.findFirst({ where: { id: trashId, spaceId: space.id } });
          const intent = entry ? null : await this.readIntent(trashId);
          if (entry) {
            await this.finishTrash(abs, entry.storePath);
          } else if (intent && (intent.spaceId ?? intent.userId) === space.id) {
            await this.undoStaging(space, abs, trashId, intent);
          } else {
            this.log.warn(`staged trash ${abs} has neither a trash entry nor an intent; leaving it untouched`);
            continue;
          }
          await this.dropIntent(trashId);
          handled++;
        } catch (e) {
          this.log.error(`cannot recover staged trash ${abs}: ${(e as Error).message}`);
        }
      }
    }
    return handled;
  }

  /** The delete never committed: put the entry back, or into the trash if its place is taken. */
  private async undoStaging(space: IndexSpace, staged: string, trashId: string, intent: TrashIntent): Promise<void> {
    const restored = await this.prisma.$transaction(async (tx) => {
      await this.journal.lockSpace(tx, space.id); // serialize with a concurrently starting indexer
      try {
        await this.assertRealDir(space, parentOf(intent.originalRel));
      } catch {
        return false;
      }
      const dst = this.abs(space, intent.originalRel);
      try {
        await moveAcrossFs(staged, dst); // no-replace, copy fallback across mounts
      } catch (e) {
        if (isEexist(e)) return false;
        throw e;
      }
      return true;
    }, TX_OPTS);
    if (restored) {
      this.log.warn(`restored ${intent.originalRel} of space ${space.id} from an interrupted delete`);
      return;
    }
    const storePath = path.join(this.config.metaRoot, 'trash', trashId, intent.name);
    const deletedAt = new Date();
    await this.prisma.trashEntry.create({
      data: {
        id: trashId, spaceId: space.id, itemId: intent.itemId, type: intent.type, name: intent.name, originalPath: intent.originalRel,
        size: await sizeOf(staged), storePath, manifest: [{ id: intent.itemId, type: intent.type, path: intent.originalRel, name: intent.name }],
        deletedAt, expiresAt: this.trashExpiry(deletedAt),
      },
    });
    await this.finishTrash(staged, storePath);
    this.log.warn(`moved ${intent.originalRel} of space ${space.id} from an interrupted delete to the trash (original path taken)`);
  }

  async openRead(space: IndexSpace, itemId: string): Promise<{ item: Item; abs: string }> {
    const item = await this.prisma.item.findFirst({ where: { id: itemId, spaceId: space.id, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    if (item.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    try {
      const abs = await realpathInside(this.abs(space, item.path), this.root(space));
      return { item, abs };
    } catch {
      throw new SyncError('not_found');
    }
  }
}
