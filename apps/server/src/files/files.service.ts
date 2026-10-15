import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Item, VersionSource } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey, tempName, TRASH_STAGING_PREFIX, trashStagingName, validateName } from '../common/names';
import { absPath, joinRel, parentRel as parentOf, realpathInside, userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { ItemStore } from '../journal/item-store';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { VersionsService } from '../versions/versions.service';
import { linkNoReplace, moveAcrossFs, moveNoReplace, replaceAtomic, statEntry } from './fs-ops';

export type OnConflict = 'fail' | 'rename';

export function itemEtag(item: Item): string {
  return item.type === 'file' ? `v${item.version}` : `t${item.updatedAt.getTime()}`;
}

const errno = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const isEexist = (e: unknown) => errno(e) === 'EEXIST';

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
interface TrashIntent { userId: string; username: string; itemId: string; originalRel: string; name: string; type: 'folder' | 'file' }

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
export class FilesService implements OnModuleDestroy {
  private readonly log = new Logger(FilesService.name);
  /** Serialized background moves of committed deletes from their staging entry to /meta/trash. */
  private trashQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly versions: VersionsService,
  ) {}

  private abs(user: IndexUser, rel: string) { return absPath(this.config.dataRoot, user.username, rel); }

  private root(user: IndexUser) { return userRoot(this.config.dataRoot, user.username); }

  /**
   * Asserts that folder `rel` is a chain of real directories below the user root: no symlinked
   * ancestor (e.g. `Docs -> ../bob` swapped in after indexing), nothing resolving outside the root.
   * Called under the user lock right before every disk mutation, so nothing is touched otherwise.
   */
  async assertRealDir(user: IndexUser, rel: string): Promise<void> {
    const root = this.root(user);
    let cur = root;
    for (const seg of rel === '' ? [] : rel.split('/')) {
      cur = path.join(cur, seg);
      const st = await lstat(cur).catch(() => null);
      if (!st?.isDirectory()) throw new SyncError('not_found', 'folder missing on disk or not a real folder');
    }
    try {
      await realpathInside(cur, root);
    } catch {
      throw new SyncError('not_found', 'path escapes the user root');
    }
  }

  /** Checks an indexed entry before mutating it: real parent chain, and still the indexed type. */
  private async entryOnDisk(user: IndexUser, item: Item): Promise<'ok' | 'missing'> {
    await this.assertRealDir(user, parentOf(item.path));
    const st = await lstat(this.abs(user, item.path)).catch((e) => (errno(e) === 'ENOENT' ? null : Promise.reject(e)));
    if (!st) return 'missing';
    if (item.type === 'folder' ? !st.isDirectory() : !st.isFile()) throw new SyncError('not_found', 'entry on disk is not the indexed type');
    return 'ok';
  }

  private checkName(raw: string): string {
    const err = validateName(raw);
    if (err) throw new SyncError('invalid_name', `invalid name (${err})`);
    return raw.normalize('NFC');
  }

  private async parentPath(tx: Tx, user: IndexUser, parentId: string | null): Promise<string> {
    if (parentId === null) return '';
    const p = await this.store.getLive(tx, user.id, parentId);
    if (!p) throw new SyncError('not_found', 'parent not found');
    if (p.type !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    return p.path;
  }

  private async takenKeys(tx: Tx, user: IndexUser, parentId: string | null, excludeId?: string) {
    const sibs = (await this.store.liveChildren(tx, user.id, parentId)).filter((s) => s.id !== excludeId);
    return { sibs, keys: new Set(sibs.map((s) => s.nameKey)) };
  }

  /** Journals the items plus same-key siblings (their display names may change). */
  private async announce(tx: Tx, user: IndexUser, items: Item[], extra: { parentId: string | null; key: string }[] = []) {
    const ids = new Set(items.map((i) => i.id));
    const sibs: Item[] = [];
    for (const { parentId, key } of [...items.map((i) => ({ parentId: i.parentId, key: i.nameKey })), ...extra]) {
      sibs.push(...(await this.store.sameKeySiblings(tx, user.id, parentId, [key], ids)));
    }
    await this.journal.record(tx, user.id, [...items, ...sibs], 'upsert');
  }

  async createFolder(user: IndexUser, parentId: string | null, rawName: string, onConflict: OnConflict = 'fail'): Promise<Item> {
    const desired = this.checkName(rawName);
    let created: string | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const parentRel = await this.parentPath(tx, user, parentId);
        const { sibs, keys } = await this.takenKeys(tx, user, parentId);
        await this.assertRealDir(user, parentRel);
        let name = desired;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) {
            if (onConflict === 'fail') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
            name = freeName(desired, keys, true);
          }
          try {
            await mkdir(this.abs(user, joinRel(parentRel, name)));
            created = this.abs(user, joinRel(parentRel, name));
            break;
          } catch (e) {
            if (!isEexist(e) || attempt > 100) throw mapMissing(e, 'parent folder');
            if (onConflict === 'fail') throw new SyncError('name_conflict', 'exists on disk');
            keys.add(nameKey(name)); // unindexed entry on disk – try the next free name
          }
        }
        const rel = joinRel(parentRel, name);
        const st = await statEntry(this.abs(user, rel));
        const item = await tx.item.create({
          data: { ownerId: user.id, parentId, type: 'folder', name, nameKey: nameKey(name), path: rel, size: 0n, mtime: st.mtime, ino: st.ino, dev: st.dev },
        });
        await this.announce(tx, user, [item]);
        return item;
      }, TX_OPTS);
    } catch (e) {
      // Rolled back: take the (still empty) folder away again so the indexer does not adopt it.
      if (created) await rmdir(created).catch(() => {});
      throw e;
    }
  }

  /** Streams the body into a temp file in the user root (same file system as the target). */
  private async receive(user: IndexUser, body: Readable, modifiedAt?: Date | null): Promise<{ tmp: string; size: bigint; sha256: string }> {
    const tmp = path.join(this.root(user), tempName(randomBytes(8).toString('hex')));
    const hash = createHash('sha256');
    let size = 0;
    const max = this.config.maxUploadBytes;
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
      throw e;
    }
    return { tmp, size: BigInt(size), sha256: hash.digest('hex') };
  }

  async upload(user: IndexUser, parentId: string | null, rawName: string, body: Readable, opts: { onConflict?: OnConflict; modifiedAt?: Date | null }): Promise<Item> {
    guardBody(body);
    const desired = this.checkName(rawName);
    await this.prisma.$transaction((tx) => this.parentPath(tx, user, parentId)); // fail fast before streaming
    const { tmp, sha256 } = await this.receive(user, body, opts.modifiedAt);
    try {
      return await this.publishNew(user, parentId, desired, tmp, sha256, opts.onConflict ?? 'fail');
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Creates a file from a received temp file (hard link, never replacing). The caller removes `tmp`. */
  private async publishNew(user: IndexUser, parentId: string | null, desired: string, tmp: string, sha256: string, onConflict: OnConflict): Promise<Item> {
    let published: { abs: string; ino: bigint } | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const parentRel = await this.parentPath(tx, user, parentId);
        const { sibs, keys } = await this.takenKeys(tx, user, parentId);
        await this.assertRealDir(user, parentRel);
        let name = desired;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) {
            if (onConflict !== 'rename') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
            name = freeName(desired, keys, false);
          }
          try {
            await linkNoReplace(tmp, this.abs(user, joinRel(parentRel, name)));
            break;
          } catch (e) {
            if (!isEexist(e) || attempt > 100) throw mapMissing(e, 'parent folder');
            if (onConflict !== 'rename') throw new SyncError('name_conflict', 'exists on disk');
            keys.add(nameKey(name)); // unindexed entry on disk – try the next free name
          }
        }
        const rel = joinRel(parentRel, name);
        const st = await statEntry(this.abs(user, rel));
        published = { abs: this.abs(user, rel), ino: st.ino };
        const item = await tx.item.create({
          data: { ownerId: user.id, parentId, type: 'file', name, nameKey: nameKey(name), path: rel, size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256 },
        });
        await this.announce(tx, user, [item]);
        return item;
      }, TX_OPTS);
    } catch (e) {
      // Rolled back after publishing: withdraw our file (only if it is still ours).
      const p = published as { abs: string; ino: bigint } | null;
      if (p) {
        const now = await statEntry(p.abs).catch(() => null);
        if (now && now.ino === p.ino) await unlink(p.abs).catch(() => {});
      }
      throw e;
    }
  }

  /** New file from a template (e.g. an empty office document); a taken name gets a free suffix. */
  async createFromTemplate(user: IndexUser, parentId: string | null, rawName: string, templatePath: string): Promise<Item> {
    return this.upload(user, parentId, rawName, createReadStream(templatePath), { onConflict: 'rename' });
  }

  /**
   * Under the user lock: the live file row and its absolute path. A host edit that is not indexed
   * yet is recorded as a new version first (`changedOnDisk`), so it is never overwritten blindly.
   */
  private async lockedFile(tx: Tx, user: IndexUser, itemId: string): Promise<{ item: Item; target: string; changedOnDisk: boolean }> {
    const item = await this.store.getLive(tx, user.id, itemId);
    if (!item || item.type !== 'file') throw new SyncError('not_found');
    const target = this.abs(user, item.path);
    // Deleted (or replaced by a folder) on the host but not indexed yet: never resurrect it
    // blindly; the indexer will journal the delete.
    if ((await this.entryOnDisk(user, item)) === 'missing') throw new SyncError('not_found', 'file missing on disk');
    const disk = await statEntry(target);
    // A new inode with equal size+mtime is an atomic save (temp + rename) on the host. Our own
    // writes store the inode they produce, so this never fires for them.
    const inoChanged = item.ino !== null && (disk.ino !== item.ino || disk.dev !== item.dev);
    if (inoChanged || disk.size !== item.size || disk.mtime.getTime() !== item.mtime.getTime()) {
      const fresh = await tx.item.update({
        where: { id: item.id },
        data: { size: disk.size, mtime: disk.mtime, ino: disk.ino, dev: disk.dev, contentHash: null, version: { increment: 1 }, officeKey: null },
      });
      await this.journal.record(tx, user.id, [fresh], 'upsert');
      return { item: fresh, target, changedOnDisk: true };
    }
    return { item, target, changedOnDisk: false };
  }

  /** Keeps the current content as a version, then swaps in `tmp` atomically (version + 1, journaled). */
  private async commitReplace(
    tx: Tx, user: IndexUser, item: Item, target: string, tmp: string, sha256: string,
    source: VersionSource, opts: { officeKey: string | null; by?: string },
  ): Promise<Item> {
    await this.versions.capture(tx, user, item, target, source, opts.by);
    await replaceAtomic(tmp, target);
    const st = await statEntry(target);
    const updated = await tx.item.update({
      where: { id: item.id },
      data: { size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256, version: { increment: 1 }, officeKey: opts.officeKey },
    });
    await this.journal.record(tx, user.id, [updated], 'upsert');
    return updated;
  }

  async replaceContent(user: IndexUser, itemId: string, body: Readable, opts: { ifMatchVersion: number | null; modifiedAt?: Date | null }): Promise<Item> {
    guardBody(body);
    const pre = await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } });
    if (!pre || pre.type !== 'file') throw new SyncError('not_found');
    // ifMatchVersion null = `If-Match: *` (any current version).
    if (opts.ifMatchVersion !== null && pre.version !== opts.ifMatchVersion) throw new SyncError('conflict', 'version mismatch', pre);
    const { tmp, sha256 } = await this.receive(user, body, opts.modifiedAt);
    try {
      // The transaction returns the conflict instead of throwing, so the recorded
      // external version is committed before the 412 goes out.
      const outcome = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const { item, target, changedOnDisk } = await this.lockedFile(tx, user, itemId);
        // Edited on the host but not yet indexed: that version is recorded, report the conflict.
        if (changedOnDisk) return { conflict: item, reason: 'file changed on disk' } as const;
        if (opts.ifMatchVersion !== null && item.version !== opts.ifMatchVersion) return { conflict: item, reason: 'version mismatch' } as const;
        return { ok: await this.commitReplace(tx, user, item, target, tmp, sha256, 'api', { officeKey: null }) } as const;
      }, TX_OPTS);
      if ('conflict' in outcome) throw new SyncError('conflict', outcome.reason, outcome.conflict);
      return outcome.ok;
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
   * A file that is gone (trashed, deleted on the host) discards the save.
   */
  async saveOfficeContent(
    user: IndexUser, itemId: string, body: Readable,
    opts: { key: string; baseVersion: number; by?: string; conflictName: (name: string) => string },
  ): Promise<{ outcome: 'replaced' | 'conflict'; item: Item } | { outcome: 'discarded' }> {
    guardBody(body);
    const { tmp, sha256 } = await this.receive(user, body);
    try {
      const decided = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        let cur: Awaited<ReturnType<FilesService['lockedFile']>>;
        try {
          cur = await this.lockedFile(tx, user, itemId);
        } catch (e) {
          if (e instanceof SyncError && e.code === 'not_found') return { outcome: 'discarded' } as const;
          throw e;
        }
        const { item, target } = cur;
        if (item.version !== opts.baseVersion && item.officeKey !== opts.key) return { outcome: 'conflict', item } as const;
        return { outcome: 'replaced', item: await this.commitReplace(tx, user, item, target, tmp, sha256, 'office', { officeKey: opts.key, by: opts.by }) } as const;
      }, TX_OPTS);
      if (decided.outcome !== 'conflict') return decided;
      const copy = await this.publishNew(user, decided.item.parentId, opts.conflictName(decided.item.name), tmp, sha256, 'rename');
      return { outcome: 'conflict', item: copy };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async update(user: IndexUser, itemId: string, patch: { name?: string; parentId?: string | null }, opts: { ifMatchEtag?: string } = {}): Promise<Item> {
    const newName = patch.name === undefined ? undefined : this.checkName(patch.name);
    let moved: { from: string; to: string } | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const item = await this.store.getLive(tx, user.id, itemId);
        if (!item) throw new SyncError('not_found');
        if (opts.ifMatchEtag && opts.ifMatchEtag !== itemEtag(item)) throw new SyncError('conflict', 'etag mismatch', item);
        const targetParent = patch.parentId === undefined ? item.parentId : patch.parentId;
        const name = newName ?? item.name;
        if (targetParent === item.parentId && name === item.name) return item;
        const parentRel = await this.parentPath(tx, user, targetParent);
        if (item.type === 'folder' && (parentRel === item.path || parentRel.startsWith(item.path + '/'))) {
          throw new SyncError('invalid_move', 'cannot move a folder into itself');
        }
        const { sibs, keys } = await this.takenKeys(tx, user, targetParent, item.id);
        if (keys.has(nameKey(name))) throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
        if ((await this.entryOnDisk(user, item)) === 'missing') throw new SyncError('not_found', 'entry missing on disk');
        await this.assertRealDir(user, parentRel);
        const rel = joinRel(parentRel, name);
        const from = this.abs(user, item.path);
        const to = this.abs(user, rel);
        try {
          await moveNoReplace(from, to);
          moved = { from, to };
        } catch (e) {
          if (isEexist(e)) throw new SyncError('name_conflict', 'exists on disk');
          throw mapMissing(e, 'item or target folder');
        }
        const updated = await tx.item.update({ where: { id: item.id }, data: { parentId: targetParent, name, nameKey: nameKey(name), path: rel } });
        if (item.type === 'folder') await this.store.rewritePrefix(tx, user.id, item.path, rel);
        await this.announce(tx, user, [updated], [{ parentId: item.parentId, key: item.nameKey }]);
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
   * Deletes an item into the trash. The entry is vacated atomically under the user lock by
   * renaming it to an ignored staging name in the user root (`.synclet-trash-<id>`, same file
   * system, so neither the indexer nor a concurrent API call can ever see it half-gone); the
   * possibly slow copy to /meta happens after commit, in the background (`pendingTrash()`).
   * A crash in between is finished by `recoverStagedTrash()` at the next start.
   */
  async remove(user: IndexUser, itemId: string): Promise<void> {
    const trashId = randomUUID();
    const staging = path.join(this.root(user), trashStagingName(trashId));
    let staged: { from: string; storePath: string } | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const item = await this.store.getLive(tx, user.id, itemId);
        if (!item) throw new SyncError('not_found');
        // Already gone on the host (not indexed yet): the delete stands, there is nothing to trash.
        if ((await this.entryOnDisk(user, item)) === 'ok') {
          const from = this.abs(user, item.path);
          await this.writeIntent(trashId, { userId: user.id, username: user.username, itemId: item.id, originalRel: item.path, name: item.name, type: item.type });
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
              id: trashId, ownerId: user.id, itemId: item.id, type: item.type, name: item.name, originalPath: item.path,
              size: gone.reduce((s, i) => s + i.size, 0n), storePath: (staged as { storePath: string }).storePath,
              manifest: gone.map(manifestEntry), deletedAt, expiresAt: this.trashExpiry(deletedAt),
            },
          });
        }
        await this.journal.record(tx, user.id, gone, 'delete');
        const sibs = await this.store.sameKeySiblings(tx, user.id, item.parentId, [item.nameKey], new Set([item.id]));
        await this.journal.record(tx, user.id, sibs, 'upsert');
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
   * Finishes trash moves interrupted by a crash. For every `.synclet-trash-<id>` in a user root:
   * - TrashEntry exists (crash after commit): move it into its storePath.
   * - only the intent file exists (crash before commit, so the delete never happened): move it
   *   back to its original path if that is free, otherwise into /meta/trash/<id>/ with a new
   *   TrashEntry; the indexer reconciles the rows either way.
   * - neither: log and leave it untouched.
   * Returns the number of staged entries handled.
   */
  async recoverStagedTrash(): Promise<number> {
    let handled = 0;
    for (const u of await this.prisma.user.findMany({ select: { id: true, username: true } })) {
      const root = userRoot(this.config.dataRoot, u.username);
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
          const entry = await this.prisma.trashEntry.findFirst({ where: { id: trashId, ownerId: u.id } });
          const intent = entry ? null : await this.readIntent(trashId);
          if (entry) {
            await this.finishTrash(abs, entry.storePath);
          } else if (intent && intent.userId === u.id) {
            await this.undoStaging(u, abs, trashId, intent);
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
  private async undoStaging(user: IndexUser, staged: string, trashId: string, intent: TrashIntent): Promise<void> {
    const restored = await this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, user.id); // serialize with a concurrently starting indexer
      try {
        await this.assertRealDir(user, parentOf(intent.originalRel));
      } catch {
        return false;
      }
      const dst = this.abs(user, intent.originalRel);
      try {
        await moveAcrossFs(staged, dst); // no-replace, copy fallback across mounts
      } catch (e) {
        if (isEexist(e)) return false;
        throw e;
      }
      return true;
    }, TX_OPTS);
    if (restored) {
      this.log.warn(`restored ${intent.originalRel} of ${user.username} from an interrupted delete`);
      return;
    }
    const storePath = path.join(this.config.metaRoot, 'trash', trashId, intent.name);
    const deletedAt = new Date();
    await this.prisma.trashEntry.create({
      data: {
        id: trashId, ownerId: user.id, itemId: intent.itemId, type: intent.type, name: intent.name, originalPath: intent.originalRel,
        size: await sizeOf(staged), storePath, manifest: [{ id: intent.itemId, type: intent.type, path: intent.originalRel, name: intent.name }],
        deletedAt, expiresAt: this.trashExpiry(deletedAt),
      },
    });
    await this.finishTrash(staged, storePath);
    this.log.warn(`moved ${intent.originalRel} of ${user.username} from an interrupted delete to the trash (original path taken)`);
  }

  async openRead(user: IndexUser, itemId: string): Promise<{ item: Item; abs: string }> {
    const item = await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    if (item.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    try {
      const abs = await realpathInside(this.abs(user, item.path), this.root(user));
      return { item, abs };
    } catch {
      throw new SyncError('not_found');
    }
  }
}
