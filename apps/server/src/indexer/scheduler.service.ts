import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { isTempName } from '../common/names';
import { DerivativesGc } from '../derivatives/derivatives-gc';
import type { IndexUser } from '../common/types';
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoveryService } from '../spaces/discovery.service';
import { IndexableSpace, SpacesRepo } from '../spaces/spaces.repo';
import { TrashService } from '../trash/trash.service';
import { TusService } from '../uploads/tus';
import { VersionsService } from '../versions/versions.service';
import { IndexerService } from './indexer.service';
import { WatcherService } from './watcher.service';

const DAY = 24 * 3600 * 1000;
const SESSION_RETENTION_DAYS = 30;
/** Shortest pause between scan cycles, whatever a space's own interval says. */
const MIN_CYCLE_MS = 10_000;

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(SchedulerService.name);
  private timers: NodeJS.Timeout[] = [];
  private scanTimer?: NodeJS.Timeout;
  private stopped = false;
  private scanning = false;
  /** Start of the last scan attempt per space id (per-space scan intervals). */
  private readonly lastScan = new Map<string, number>();
  /** Pause until the next cycle: the global interval, or a shorter per-space interval. */
  private cycleMs = 0;
  lastFullScanAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly watcher: WatcherService,
    private readonly files: FilesService,
    private readonly trash: TrashService,
    private readonly uploads: TusService,
    private readonly derivativesGc: DerivativesGc,
    private readonly versions: VersionsService,
    private readonly spaces: SpacesRepo,
    private readonly discovery: DiscoveryService,
    events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    // A new user may adopt an existing folder: index it now instead of at the next periodic scan
    // (the watcher only reports changes, so untouched content would stay invisible until then).
    events.on('user.created', (u) => { if (this.config.background) void this.scanUser(u); });
  }

  async onApplicationBootstrap() {
    if (!this.config.background) return;
    await this.startup();
    // Only now: a watcher-triggered reconcile during recovery could tombstone vacated entries.
    await this.watcher.start();
    // Not awaited: the server must listen without walking every (network) storage first.
    this.deepCleanupRun = this.deepCleanup().catch((e) => { this.log.error(`deep cleanup failed: ${(e as Error).message}`); return 0; });
    // Maintenance also runs once right after the first scan: hosts that restart daily would
    // otherwise never reach the 24 h timer.
    this.stopped = false;
    this.initialRun = this.scanAll().then(() => { this.scheduleNextScan(); return this.runMaintenance(); });
    this.timers.push(setInterval(() => void this.runMaintenance(), DAY));
  }

  /** Periodic cycles: only spaces whose own interval (default: the global one) has elapsed. */
  private scheduleNextScan(): void {
    if (this.stopped) return;
    this.scanTimer = setTimeout(() => {
      void this.scanAll({ dueOnly: true }).finally(() => this.scheduleNextScan());
    }, this.cycleMs || this.config.scanIntervalSec * 1000);
  }

  /** The background deep temp sweep started at boot (awaitable for tests). */
  deepCleanupRun: Promise<number> = Promise.resolve(0);

  /** First scan + first maintenance after boot (awaitable for tests). */
  initialRun: Promise<void> = Promise.resolve();

  private runMaintenance(): Promise<void> {
    return this.maintenance().catch((e) => this.log.error(`maintenance failed: ${(e as Error).message}`));
  }

  onModuleDestroy() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    clearTimeout(this.scanTimer);
  }

  private async discover(): Promise<void> {
    const res = await this.discovery.discover().catch((e) => { this.log.error(`space discovery failed: ${(e as Error).message}`); return null; });
    if (res?.created.length) this.log.log(`discovered ${res.created.length} new space(s)`);
  }

  /**
   * Runs before the first scan: removes crash leftovers and finishes/undoes interrupted deletes.
   * Recovery must complete first – a scan would otherwise journal deletes for entries that a
   * crash before commit left vacated but whose delete never happened.
   */
  async startup(): Promise<void> {
    await this.discover();
    await this.startupCleanup();
    await this.files.recoverStagedTrash().catch((e) => this.log.error(`trash recovery failed: ${(e as Error).message}`));
  }

  /**
   * Removes `.synclet-tmp-*` files and directories left by crashes; at boot nothing is in flight,
   * so no age gate applies. Personal spaces are swept at any depth. Team folders and external
   * storages (possibly huge network mounts) only at their top level, where uploads and moves
   * between spaces keep their temp entries; the deep sweep of those runs after the server listens
   * (`deepCleanup`). Symlinks are never followed; `.synclet-trash-*` is never touched.
   */
  async startupCleanup(): Promise<number> {
    this.bootAt = new Date();
    let removed = 0;
    for (const { space, name, readOnly } of await this.writableSpaces()) {
      removed += await this.sweep(space.rootPath, name, { deep: space.kind === 'personal' });
    }
    return removed;
  }

  /**
   * The deep sweep of team folders and external storages, in the background after boot: removes
   * temp entries below their top level that were last changed before `before` (default: the boot),
   * so nothing an upload or move started since then is touched.
   */
  async deepCleanup(before: Date = this.bootAt ?? new Date()): Promise<number> {
    let removed = 0;
    for (const { space, name } of await this.writableSpaces()) {
      if (space.kind === 'personal' || this.stopped) continue;
      removed += await this.sweep(space.rootPath, name, { deep: true, before });
    }
    if (removed) this.log.log(`deep cleanup removed ${removed} temp leftover(s) in team folders and storages`);
    return removed;
  }

  /** Boot time of the startup cleanup (the deep sweep's age gate). */
  private bootAt?: Date;

  private async writableSpaces(): Promise<IndexableSpace[]> {
    const spaces = await this.spaces.indexable().catch((e) => { this.log.error(`startup cleanup: ${(e as Error).message}`); return [] as IndexableSpace[]; });
    return spaces.filter((s) => !s.readOnly);
  }

  private async sweep(root: string, owner: string, opts: { deep: boolean; before?: Date }): Promise<number> {
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        try {
          if (isTempName(e.name)) {
            const st = await lstat(abs);
            if (st.isSymbolicLink()) continue;
            // ctime cannot be set by clients (unlike mtime): newer means created after `before`.
            if (opts.before && st.ctime >= opts.before) continue;
            if (st.isDirectory() || st.isFile()) { await rm(abs, { recursive: true, force: true }); removed++; }
          } else if (opts.deep && e.isDirectory() && !e.name.startsWith('.synclet-trash-')) {
            await walk(abs); // Dirent from readdir never follows symlinks
          }
        } catch (err) {
          this.log.warn(`startup cleanup: cannot remove ${abs} (${owner}): ${(err as Error).message}`);
        }
      }
    };
    await walk(root);
    return removed;
  }

  /**
   * Discovers team/storage folders, then scans every indexable space (missing ones are skipped).
   * `dueOnly` (periodic cycles): only spaces whose scan interval has elapsed since their last scan.
   */
  async scanAll(opts: { dueOnly?: boolean } = {}): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.discover();
      await this.watcher.refresh().catch((e) => this.log.warn(`space refresh failed: ${(e as Error).message}`));
      const globalMs = this.config.scanIntervalSec * 1000;
      const spaces = await this.spaces.indexable();
      this.cycleMs = Math.max(MIN_CYCLE_MS, Math.min(globalMs, ...spaces.map((s) => (s.scanIntervalSec ?? Infinity) * 1000)));
      let allScanned = true;
      for (const { space, name, scanIntervalSec } of spaces) {
        const now = Date.now();
        const last = this.lastScan.get(space.id);
        // Small slack: a cycle timer firing a few ms early must not skip a space for a whole cycle.
        if (opts.dueOnly && last !== undefined && now - last < (scanIntervalSec ?? this.config.scanIntervalSec) * 1000 - 1000) continue;
        this.lastScan.set(space.id, now);
        const label = `${space.kind} ${name}`;
        const stats = await this.indexer.fullScan(space).catch((e) => { this.log.error(`scan ${label}: ${(e as Error).message}`); return null; });
        if (!stats) { allScanned = false; continue; }
        if (stats.created || stats.updated || stats.moved || stats.deleted) this.log.log(`scan ${label}: ${JSON.stringify(stats)}`);
      }
      // A refused or failed scan (e.g. unmounted volume) must not count as a completed one.
      if (allScanned) this.lastFullScanAt = new Date();
    } catch (e) {
      this.log.error(`scan failed: ${(e as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  async scanUser(u: IndexUser): Promise<void> {
    const stats = await this.spaces.personalFor(u.id).then((space) => this.indexer.fullScan(space)).catch((e) => { this.log.error(`scan ${u.username}: ${(e as Error).message}`); return null; });
    if (stats && (stats.created || stats.updated || stats.moved || stats.deleted)) this.log.log(`scan ${u.username}: ${JSON.stringify(stats)}`);
  }

  async maintenance(): Promise<void> {
    const before = new Date(Date.now() - this.config.journalRetentionDays * DAY);
    for (const { id } of await this.prisma.space.findMany({ select: { id: true } })) await this.journal.trim(id, before);
    await this.store.purgeTombstones(new Date(Date.now() - Math.max(this.config.tombstoneWindowSec * 1000, DAY)));
    // Expired or revoked web sessions are kept for a while (refresh-token reuse detection), then dropped.
    const sessionCutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * DAY);
    await this.prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }] } });
    // Trash entries past their retention (files in /meta/trash + rows).
    await this.trash.expire();
    // File versions: retention buckets, SYNCLET_VERSIONS_MAX_BYTES, versions of items gone for good.
    const pruned = await this.versions.prune().catch((e) => { this.log.warn(`version prune failed: ${(e as Error).message}`); return null; });
    if (pruned && (pruned.orphaned || pruned.expired || pruned.evicted)) this.log.log(`versions pruned: ${JSON.stringify(pruned)}`);
    // Abandoned resumable uploads (tus parts in /meta/uploads older than 24 h).
    const expired = await this.uploads.expire().catch((e) => { this.log.warn(`upload expiry failed: ${(e as Error).message}`); return 0; });
    if (expired) this.log.log(`removed ${expired} abandoned upload(s)`);
    // Last: tombstones purged above no longer keep their derivatives alive.
    const gc = await this.derivativesGc.run();
    if (gc.dirs || gc.jobs || gc.texts) this.log.log(`derivatives gc: ${gc.dirs} dirs, ${gc.jobs} job rows, ${gc.texts} extracted texts removed`);
    if (gc.requeued) this.log.log(`derivatives gc: ${gc.requeued} thumbnail job(s) with missing files requeued`);
  }
}
