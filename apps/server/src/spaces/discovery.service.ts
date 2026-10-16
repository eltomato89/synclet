import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, Space, SpaceKind } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { UUID } from '../common/ids';
import { isIgnored, nameKey, validateName } from '../common/names';
import { isRealDir as isDir } from '../common/paths';
import { SyncError } from '../common/sync-error';
import { JournalService } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { AccountSignal } from './account-signal';
import { SpaceAccess, type SpaceRow } from './space-access.service';

type Tx = Prisma.TransactionClient;
type DiscoveredKind = Extract<SpaceKind, 'team' | 'external'>;

/** Disk errors that mean "the server user may not write here" (owner, mode, read-only mount). */
const NOT_WRITABLE = ['EACCES', 'EPERM', 'EROFS'];
const isErrno = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? '');

/**
 * Turns the direct subfolders of the teams root (`/teams`) and the storage root (`/storage`) into
 * spaces (spec §2.2) and keeps their status in line with the disk:
 * - missing: the root is not a directory, or it is empty while the space has live items; for teams
 *   additionally every team space while `/teams` itself is empty and any team space has items.
 * - readOnly: `access(root, W_OK)` fails.
 * Never deletes anything on disk; missing spaces keep their index (the scheduler skips them).
 * Removed spaces stay as rows with status `ignored`: their folder is never turned into a space
 * again (matched by rootPath) until `restoreSpace`.
 */
@Injectable()
export class DiscoveryService {
  private readonly log = new Logger(DiscoveryService.name);
  /** Discovery and admin changes of this process run one at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly events: AppEvents,
    private readonly access: SpaceAccess,
    private readonly signal: AccountSignal,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Scans teamsRoot and storageRoot; creates new spaces (no members), marks missing/available,
   * detects readOnly. Members of changed spaces get an `account` signal (status/canWrite in /account).
   */
  discover(): Promise<{ created: string[]; changed: string[] }> {
    return this.serial(async () => {
      const created: string[] = [];
      const changed: string[] = [];
      const affected = new Set<string>();
      for (const [kind, parent] of [['team', this.config.teamsRoot], ['external', this.config.storageRoot]] as const) {
        const names = await this.candidates(parent);
        const rows = await this.prisma.space.findMany({ where: { kind } });
        const known = new Set(rows.map((r) => r.rootPath));
        for (const name of names) {
          const root = path.join(parent, name);
          if (known.has(root)) continue;
          const row = await this.createRow(kind, name, root);
          if (row) { created.push(row.id); this.log.log(`discovered ${kind} space "${name}" (${root})`); }
        }
        // An empty /teams while team spaces hold items: the volume is not mounted.
        const parentGone = kind === 'team' && names.length === 0 && rows.length > 0 && (await this.anyLiveItems(rows.filter((r) => r.status !== 'ignored').map((r) => r.id)));
        for (const row of rows) {
          if (row.status === 'ignored') continue;
          const next = await this.probe(row, parentGone);
          if (next.status === row.status && next.readOnly === row.readOnly) continue;
          await this.prisma.$transaction(async (tx) => {
            await this.journal.lockSpace(tx, row.id);
            await tx.space.update({ where: { id: row.id }, data: next });
          }, TX_OPTS);
          changed.push(row.id);
          for (const u of await this.access.usersOf(row.id)) affected.add(u);
          const what = next.status !== row.status ? `now ${next.status}` : `readOnly=${next.readOnly}`;
          (next.status === 'missing' ? this.log.warn.bind(this.log) : this.log.log.bind(this.log))(`${kind} space "${row.name}" (${row.rootPath}) ${what}`);
        }
      }
      if (created.length || changed.length) this.events.emit('spaces.changed');
      await this.signal.notify(affected);
      return { created, changed };
    });
  }

  /**
   * Creates the team folder `teamsRoot/<name>` and its space. `init` runs in the same transaction
   * (e.g. adding members): when it throws, neither the row nor the folder is left behind.
   */
  createTeam(rawName: string, init?: (tx: Tx, row: Space) => Promise<void>): Promise<SpaceRow> {
    return this.serial(async () => {
      const name = this.checkName(rawName);
      const parent = this.config.teamsRoot;
      if (!(await isDir(parent))) throw new SyncError('space_unavailable', `teams folder ${parent} is not available`);
      const root = path.join(parent, name);
      const row = await this.prisma.$transaction(async (tx) => {
        await this.lockDiscovery(tx);
        await this.assertTeamNameFree(tx, parent, name, null);
        try {
          await mkdir(root);
        } catch (e) {
          if (isErrno(e, 'EEXIST')) throw new SyncError('name_conflict', 'a folder with this name exists');
          if (isErrno(e, ...NOT_WRITABLE)) throw notWritable(parent);
          throw e;
        }
        try {
          const created = await this.insert(tx, 'team', name, root, false);
          await init?.(tx, created);
          return created;
        } catch (e) {
          await rmdir(root).catch(() => {});
          throw e;
        }
      }, TX_OPTS);
      this.events.emit('spaces.changed');
      return row;
    });
  }

  /** Renames a team folder on disk and its space (name + rootPath). Items keep their relative paths. */
  renameTeam(id: string, rawName: string): Promise<SpaceRow> {
    return this.serial(async () => {
      const row = await this.teamRow(id);
      if (row.status === 'ignored') throw new SyncError('invalid_request', 'the team folder was removed; restore it first');
      const name = this.checkName(rawName);
      if (name === row.name) return row;
      const parent = path.dirname(row.rootPath);
      const root = path.join(parent, name);
      let renamed = false;
      let updated: Space;
      try {
        updated = await this.prisma.$transaction(async (tx) => {
          await this.lockDiscovery(tx);
          await this.journal.lockSpace(tx, row.id);
          await this.assertTeamNameFree(tx, parent, name, row);
          try {
            await rename(row.rootPath, root);
          } catch (e) {
            if (isErrno(e, 'ENOENT')) throw new SyncError('space_unavailable', 'team folder is not available');
            if (isErrno(e, 'EEXIST', 'ENOTEMPTY')) throw new SyncError('name_conflict', 'a folder with this name exists');
            if (isErrno(e, ...NOT_WRITABLE)) throw notWritable(parent);
            throw e;
          }
          renamed = true;
          return tx.space.update({ where: { id: row.id }, data: { name, rootPath: root } });
        }, TX_OPTS);
      } catch (e) {
        // Also covers a failed commit after the rename: the row still has the old name.
        if (renamed) await rename(root, row.rootPath).catch((err) => this.log.error(`cannot undo rename of ${row.rootPath}: ${(err as Error).message}`));
        throw e;
      }
      this.events.emit('spaces.changed');
      return updated;
    });
  }

  /**
   * Removes a team folder or external storage from Synclet: drops its members, index, journal,
   * trash entries, versions and share links, and keeps the row with status `ignored` so discovery
   * does not bring the still existing folder back. The folder on disk stays untouched.
   */
  removeSpace(id: string): Promise<void> {
    return this.serial(async () => {
      const row = await this.sharedRow(id);
      const trashIds = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, row.id);
        const trash = await tx.trashEntry.findMany({ where: { spaceId: row.id }, select: { id: true } });
        await tx.fileChange.deleteMany({ where: { scopeId: row.id } });
        await tx.trashEntry.deleteMany({ where: { spaceId: row.id } });
        await tx.fileVersion.deleteMany({ where: { spaceId: row.id } });
        await tx.shareLink.deleteMany({ where: { spaceId: row.id } });
        await tx.spaceMember.deleteMany({ where: { spaceId: row.id } });
        await tx.item.deleteMany({ where: { spaceId: row.id } });
        // The journal is gone: cursors handed out before must expire (full resync), not miss deletes.
        await tx.$executeRaw`UPDATE "SyncScope" SET "minSeq" = seq WHERE "spaceId" = ${row.id}::uuid`;
        await tx.space.update({ where: { id: row.id }, data: { status: 'ignored' } });
        return trash.map((t) => t.id);
      }, TX_OPTS);
      // Content kept in /meta for the removed index (never anything in the space folder).
      const meta = path.resolve(this.config.metaRoot);
      for (const dir of [path.join(meta, 'versions', row.id), ...trashIds.filter((t) => UUID.test(t)).map((t) => path.join(meta, 'trash', t))]) {
        await rm(dir, { recursive: true, force: true }).catch((e) => this.log.warn(`cannot remove ${dir}: ${(e as Error).message}`));
      }
      this.log.log(`removed ${row.kind} space "${row.name}" (folder ${row.rootPath} kept, ignored by discovery)`);
      this.events.emit('spaces.changed');
    });
  }

  /** Takes a removed space back: available (or missing per the disk), no members; the next scan re-indexes it. */
  restoreSpace(id: string): Promise<SpaceRow> {
    return this.serial(async () => {
      const row = await this.sharedRow(id);
      if (row.status !== 'ignored') return row;
      const next = await this.probe(row, false);
      const updated = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockSpace(tx, row.id);
        return tx.space.update({ where: { id: row.id }, data: next });
      }, TX_OPTS);
      this.log.log(`restored ${row.kind} space "${row.name}" (${next.status})`);
      this.events.emit('spaces.changed');
      return updated;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Direct subdirectories that may become spaces: no symlinks, no dot names, nothing on the ignore list. */
  private async candidates(parent: string): Promise<string[]> {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    // Dirent types come from lstat semantics: a symlink to a directory is not isDirectory().
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !isIgnored(e.name)).map((e) => e.name).sort();
  }

  private async probe(row: Space, parentGone: boolean): Promise<{ status: Space['status']; readOnly: boolean }> {
    if (parentGone || !(await isDir(row.rootPath))) return { status: 'missing', readOnly: row.readOnly };
    const readOnly = await isReadOnly(row.rootPath);
    const visible = await readdir(row.rootPath).then((n) => n.filter((x) => !isIgnored(x)).length, () => 0);
    const missing = visible === 0 && (await this.anyLiveItems([row.id]));
    return { status: missing ? 'missing' : 'available', readOnly };
  }

  private async anyLiveItems(spaceIds: string[]): Promise<boolean> {
    return !!(await this.prisma.item.findFirst({ where: { spaceId: { in: spaceIds }, deletedAt: null }, select: { id: true } }));
  }

  /** Creates a discovered space unless another discovery (or createTeam) got there first. */
  private createRow(kind: DiscoveredKind, name: string, root: string): Promise<Space | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockDiscovery(tx);
      if (await tx.space.findFirst({ where: { kind, rootPath: root }, select: { id: true } })) return null;
      return this.insert(tx, kind, name, root, await isReadOnly(root));
    }, TX_OPTS);
  }

  private async insert(tx: Tx, kind: DiscoveredKind, name: string, rootPath: string, readOnly: boolean): Promise<Space> {
    const row = await tx.space.create({ data: { id: randomUUID(), kind, name, rootPath, readOnly } });
    await tx.syncScope.create({ data: { spaceId: row.id } });
    return row;
  }

  /** Serializes space creation across processes (no unique constraint on rootPath). */
  private async lockDiscovery(tx: Tx): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('synclet:space-discovery', 0))`;
  }

  private checkName(raw: string): string {
    const name = typeof raw === 'string' ? raw.normalize('NFC') : '';
    const err = validateName(name);
    if (err || name.startsWith('.')) throw new SyncError('invalid_name', `invalid team folder name (${err ?? 'hidden'})`);
    return name;
  }

  /** Name unique among team spaces and folders in `parent` (case-insensitive, NFC). */
  private async assertTeamNameFree(tx: Tx, parent: string, name: string, self: Space | null): Promise<void> {
    const key = nameKey(name);
    const rows = await tx.space.findMany({ where: { kind: 'team' }, select: { id: true, name: true } });
    if (rows.some((r) => r.id !== self?.id && nameKey(r.name) === key)) throw new SyncError('name_conflict', 'a team folder with this name exists');
    const onDisk = await readdir(parent).catch(() => [] as string[]);
    const selfBase = self ? path.basename(self.rootPath) : null;
    if (onDisk.some((n) => n !== selfBase && nameKey(n) === key)) throw new SyncError('name_conflict', 'a folder with this name exists');
  }

  private async teamRow(id: string): Promise<Space> {
    const row = await this.sharedRow(id);
    if (row.kind !== 'team') throw new SyncError('invalid_request', 'only team folders can be renamed');
    return row;
  }

  /** A team folder or external storage (personal spaces are managed with their user). */
  private async sharedRow(id: string): Promise<Space> {
    const row = UUID.test(id) ? await this.prisma.space.findUnique({ where: { id } }) : null;
    if (!row) throw new SyncError('not_found', 'space not found');
    if (row.kind === 'personal') throw new SyncError('invalid_request', 'personal spaces cannot be changed here');
    return row;
  }
}

function notWritable(dir: string): SyncError {
  return new SyncError('forbidden', `Synclet cannot write to ${dir} – check owner/permissions (PUID/PGID)`);
}

async function isReadOnly(p: string): Promise<boolean> {
  return access(p, constants.W_OK).then(() => false, () => true);
}
