import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { isTempName } from '../common/names';
import { userRoot } from '../common/paths';
import type { IndexUser } from '../common/types';
import { FilesService } from '../files/files.service';
import { ItemStore } from '../journal/item-store';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { IndexerService } from './indexer.service';
import { WatcherService } from './watcher.service';

const DAY = 24 * 3600 * 1000;
const SESSION_RETENTION_DAYS = 30;

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(SchedulerService.name);
  private timers: NodeJS.Timeout[] = [];
  private scanning = false;
  lastFullScanAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly watcher: WatcherService,
    private readonly files: FilesService,
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
    // Maintenance also runs once right after the first scan: hosts that restart daily would
    // otherwise never reach the 24 h timer.
    this.initialRun = this.scanAll().then(() => this.runMaintenance());
    this.timers.push(setInterval(() => void this.scanAll(), this.config.scanIntervalSec * 1000));
    this.timers.push(setInterval(() => void this.runMaintenance(), DAY));
  }

  /** First scan + first maintenance after boot (awaitable for tests). */
  initialRun: Promise<void> = Promise.resolve();

  private runMaintenance(): Promise<void> {
    return this.maintenance().catch((e) => this.log.error(`maintenance failed: ${(e as Error).message}`));
  }

  onModuleDestroy() { this.timers.forEach(clearInterval); }

  private users() {
    return this.prisma.user.findMany({ where: { disabledAt: null }, select: { id: true, username: true } });
  }

  /**
   * Runs before the first scan: removes crash leftovers and finishes/undoes interrupted deletes.
   * Recovery must complete first – a scan would otherwise journal deletes for entries that a
   * crash before commit left vacated but whose delete never happened.
   */
  async startup(): Promise<void> {
    await this.startupCleanup();
    await this.files.recoverStagedTrash().catch((e) => this.log.error(`trash recovery failed: ${(e as Error).message}`));
  }

  /** At startup no upload is in flight, so every temp file is a leftover of a crash. */
  async startupCleanup(): Promise<number> {
    let removed = 0;
    for (const u of await this.users().catch(() => [])) {
      const root = userRoot(this.config.dataRoot, u.username);
      const names = await readdir(root).catch(() => [] as string[]);
      for (const n of names.filter(isTempName)) {
        try {
          const abs = path.join(root, n);
          if (!(await lstat(abs)).isFile()) continue; // never touch directories or symlinks
          await rm(abs, { force: true });
          removed++;
        } catch (e) {
          this.log.warn(`startup cleanup: cannot remove ${n} in ${u.username}: ${(e as Error).message}`);
        }
      }
    }
    return removed;
  }

  async scanAll(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.watcher.refreshUsers().catch((e) => this.log.warn(`user refresh failed: ${(e as Error).message}`));
      let allScanned = true;
      for (const u of await this.users()) {
        const stats = await this.indexer.fullScan(u).catch((e) => { this.log.error(`scan ${u.username}: ${(e as Error).message}`); return null; });
        if (!stats) { allScanned = false; continue; }
        if (stats.created || stats.updated || stats.moved || stats.deleted) this.log.log(`scan ${u.username}: ${JSON.stringify(stats)}`);
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
    const stats = await this.indexer.fullScan(u).catch((e) => { this.log.error(`scan ${u.username}: ${(e as Error).message}`); return null; });
    if (stats && (stats.created || stats.updated || stats.moved || stats.deleted)) this.log.log(`scan ${u.username}: ${JSON.stringify(stats)}`);
  }

  async maintenance(): Promise<void> {
    const before = new Date(Date.now() - this.config.journalRetentionDays * DAY);
    for (const u of await this.users()) await this.journal.trim(u.id, before);
    await this.store.purgeTombstones(new Date(Date.now() - Math.max(this.config.tombstoneWindowSec * 1000, DAY)));
    // Expired or revoked web sessions are kept for a while (refresh-token reuse detection), then dropped.
    const sessionCutoff = new Date(Date.now() - SESSION_RETENTION_DAYS * DAY);
    await this.prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }] } });
  }
}
