import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey, tempName, validateName } from '../common/names';
import { absPath, joinRel, realpathInside, userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { BusyPaths } from '../journal/busy-paths';
import { ItemStore } from '../journal/item-store';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { linkNoReplace, moveAcrossFs, moveNoReplace, statEntry } from './fs-ops';

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

@Injectable()
export class FilesService {
  private readonly log = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly busy: BusyPaths,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private abs(user: IndexUser, rel: string) { return absPath(this.config.dataRoot, user.username, rel); }

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
    const tmp = path.join(userRoot(this.config.dataRoot, user.username), tempName(randomBytes(8).toString('hex')));
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
    let published: { abs: string; ino: bigint } | null = null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const parentRel = await this.parentPath(tx, user, parentId);
        const { sibs, keys } = await this.takenKeys(tx, user, parentId);
        let name = desired;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) {
            if (opts.onConflict !== 'rename') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
            name = freeName(desired, keys, false);
          }
          try {
            await linkNoReplace(tmp, this.abs(user, joinRel(parentRel, name)));
            break;
          } catch (e) {
            if (!isEexist(e) || attempt > 100) throw mapMissing(e, 'parent folder');
            if (opts.onConflict !== 'rename') throw new SyncError('name_conflict', 'exists on disk');
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
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async replaceContent(user: IndexUser, itemId: string, body: Readable, opts: { ifMatchVersion: number; modifiedAt?: Date | null }): Promise<Item> {
    guardBody(body);
    const pre = await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } });
    if (!pre || pre.type !== 'file') throw new SyncError('not_found');
    if (pre.version !== opts.ifMatchVersion) throw new SyncError('conflict', 'version mismatch', pre);
    const { tmp, sha256 } = await this.receive(user, body, opts.modifiedAt);
    try {
      // The transaction returns the conflict instead of throwing, so the recorded
      // external version is committed before the 412 goes out.
      const outcome = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const item = await this.store.getLive(tx, user.id, itemId);
        if (!item || item.type !== 'file') throw new SyncError('not_found');
        const target = this.abs(user, item.path);
        // Deleted (or replaced by a folder) on the host but not indexed yet: never resurrect it
        // blindly; the indexer will journal the delete.
        const isFile = await lstat(target).then((s) => s.isFile(), () => false);
        if (!isFile) throw new SyncError('not_found', 'file missing on disk');
        const disk = await statEntry(target);
        if (disk.size !== item.size || disk.mtime.getTime() !== item.mtime.getTime()) {
          // Edited on the host but not yet indexed: record that version, then report the conflict.
          const fresh = await tx.item.update({
            where: { id: item.id },
            data: { size: disk.size, mtime: disk.mtime, ino: disk.ino, dev: disk.dev, contentHash: null, version: { increment: 1 } },
          });
          await this.journal.record(tx, user.id, [fresh], 'upsert');
          return { conflict: fresh, reason: 'file changed on disk' } as const;
        }
        if (item.version !== opts.ifMatchVersion) return { conflict: item, reason: 'version mismatch' } as const;
        await rename(tmp, target); // atomic replace
        const st = await statEntry(target);
        const updated = await tx.item.update({
          where: { id: item.id },
          data: { size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256, version: { increment: 1 } },
        });
        await this.journal.record(tx, user.id, [updated], 'upsert');
        return { ok: updated } as const;
      }, TX_OPTS);
      if ('conflict' in outcome) throw new SyncError('conflict', outcome.reason, outcome.conflict);
      return outcome.ok;
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

  async remove(user: IndexUser, itemId: string): Promise<void> {
    const trashId = randomUUID();
    const storeDir = path.join(this.config.metaRoot, 'trash', trashId);
    let item!: Item;
    // The rows are tombstoned and committed before the (possibly slow, cross-device) move to
    // /meta, so the indexer must not look at the path in between: it would otherwise pair the
    // still-present entry with its fresh tombstone and resurrect it. The busy mark is taken
    // under the user lock (before commit) and released in all cases, including a failed commit.
    let release = () => {};
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const found = await this.store.getLive(tx, user.id, itemId);
        if (!found) throw new SyncError('not_found');
        item = found;
        release = this.busy.add(user.id, item.path);
        const gone = await this.store.tombstoneSubtree(tx, item);
        await tx.trashEntry.create({
          data: {
            id: trashId, ownerId: user.id, itemId: item.id, type: item.type, name: item.name, originalPath: item.path,
            size: gone.reduce((s, i) => s + i.size, 0n), storePath: path.join(storeDir, item.name),
            manifest: gone.map((i) => ({ id: i.id, type: i.type, path: i.path })),
          },
        });
        await this.journal.record(tx, user.id, gone, 'delete');
        const sibs = await this.store.sameKeySiblings(tx, user.id, item.parentId, [item.nameKey], new Set([item.id]));
        await this.journal.record(tx, user.id, sibs, 'upsert');
      }, TX_OPTS);
      await mkdir(storeDir, { recursive: true });
      try {
        await moveAcrossFs(this.abs(user, item.path), path.join(storeDir, item.name));
      } catch (e) {
        if (errno(e) !== 'ENOENT') throw e;
        // Already gone on the host (not yet indexed): the delete stands, but there is nothing to restore.
        await rm(storeDir, { recursive: true, force: true });
        await this.prisma.trashEntry.delete({ where: { id: trashId } }).catch(() => {});
      }
    } finally {
      release();
    }
  }

  async openRead(user: IndexUser, itemId: string): Promise<{ item: Item; abs: string }> {
    const item = await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    if (item.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    try {
      const abs = await realpathInside(this.abs(user, item.path), userRoot(this.config.dataRoot, user.username));
      return { item, abs };
    } catch {
      throw new SyncError('not_found');
    }
  }
}
