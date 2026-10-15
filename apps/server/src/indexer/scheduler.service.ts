import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { isTempName } from '../common/names';
import { userRoot } from '../common/paths';
import { ItemStore } from '../journal/item-store';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { IndexerService } from './indexer.service';

const DAY = 24 * 3600 * 1000;

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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap() {
    if (!this.config.background) return;
    await this.startupCleanup();
    void this.scanAll();
    this.timers.push(setInterval(() => void this.scanAll(), this.config.scanIntervalSec * 1000));
    this.timers.push(setInterval(() => void this.maintenance().catch((e) => this.log.error(`maintenance failed: ${(e as Error).message}`)), DAY));
  }

  onModuleDestroy() { this.timers.forEach(clearInterval); }

  private users() {
    return this.prisma.user.findMany({ where: { disabledAt: null }, select: { id: true, username: true } });
  }

  /** At startup no upload is in flight, so every temp file is a leftover of a crash. */
  async startupCleanup(): Promise<number> {
    let removed = 0;
    for (const u of await this.users()) {
      const root = userRoot(this.config.dataRoot, u.username);
      const names = await readdir(root).catch(() => [] as string[]);
      for (const n of names.filter(isTempName)) { await rm(path.join(root, n), { force: true }); removed++; }
    }
    return removed;
  }

  async scanAll(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
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

  async maintenance(): Promise<void> {
    const before = new Date(Date.now() - this.config.journalRetentionDays * DAY);
    for (const u of await this.users()) await this.journal.trim(u.id, before);
    await this.store.purgeTombstones(new Date(Date.now() - Math.max(this.config.tombstoneWindowSec * 1000, DAY)));
  }
}
