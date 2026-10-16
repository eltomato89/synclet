import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminStatusWire, DiskUsage } from '@synclet/shared';
import { lstat, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulerService } from '../indexer/scheduler.service';
import { WatcherService } from '../indexer/watcher.service';
import { UpdateCheckService } from './update-check.service';

const SIZE_TTL_MS = 10 * 60_000;
const OFFICE_TTL_MS = 60_000;
/** The first call waits at most this long for the directory sizes, then reports 0 until the walk finishes. */
const FIRST_WALK_WAIT_MS = 3_000;
const STATUSES = ['pending', 'running', 'done', 'failed', 'unsupported'] as const;
type MetaSizes = AdminStatusWire['meta'];

/** Recursive size of regular files below `dir`; symlinks are neither followed nor counted; a missing dir is 0. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += await lstat(p).then((s) => s.size, () => 0);
  }
  return total;
}

@Injectable()
export class AdminStatusService {
  private readonly log = new Logger(AdminStatusService.name);
  private sizes: { value: MetaSizes; at: number } | null = null;
  private walking: Promise<MetaSizes> | null = null;
  private office: { value: boolean; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly watcher: WatcherService,
    private readonly scheduler: SchedulerService,
    private readonly updates: UpdateCheckService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async disk(dir: string): Promise<DiskUsage> {
    try {
      const s = await statfs(dir);
      return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
    } catch {
      return { totalBytes: 0, freeBytes: 0 };
    }
  }

  private walk(): Promise<MetaSizes> {
    this.walking ??= (async () => {
      const m = this.config.metaRoot;
      const [derivedBytes, trashBytes, versionsBytes, uploadsBytes] = await Promise.all(['derived', 'trash', 'versions', 'uploads'].map((d) => dirSize(path.join(m, d))));
      const value = { derivedBytes, trashBytes, versionsBytes, uploadsBytes };
      this.sizes = { value, at: Date.now() };
      return value;
    })()
      .catch((e) => { this.log.warn(`meta size walk failed: ${(e as Error).message}`); return this.sizes?.value ?? { derivedBytes: 0, trashBytes: 0, versionsBytes: 0, uploadsBytes: 0 }; })
      .finally(() => { this.walking = null; });
    return this.walking;
  }

  /**
   * Cached for 10 minutes. After the first call a stale value is returned immediately while a
   * refresh runs in the background; the first call waits up to 3 s and otherwise reports zeros.
   */
  private async metaSizes(): Promise<MetaSizes> {
    if (this.sizes) {
      if (Date.now() - this.sizes.at > SIZE_TTL_MS) void this.walk();
      return this.sizes.value;
    }
    const walk = this.walk();
    const timeout = new Promise<MetaSizes>((resolve) => setTimeout(() => resolve({ derivedBytes: 0, trashBytes: 0, versionsBytes: 0, uploadsBytes: 0 }), FIRST_WALK_WAIT_MS).unref());
    return Promise.race([walk, timeout]);
  }

  private async officeReachable(): Promise<boolean | null> {
    if (!this.config.officeUrl) return null;
    if (this.office && Date.now() - this.office.at < OFFICE_TTL_MS) return this.office.value;
    let value = false;
    try {
      const res = await fetch(`${this.config.officeInternalUrl.replace(/\/+$/, '')}/healthcheck`, { signal: AbortSignal.timeout(2_000) });
      value = res.ok;
    } catch {
      value = false;
    }
    this.office = { value, at: Date.now() };
    return value;
  }

  private async jobs(): Promise<AdminStatusWire['jobs']> {
    const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
    const out: AdminStatusWire['jobs'] = { thumb: zero(), text: zero() };
    for (const g of await this.prisma.derivativeJob.groupBy({ by: ['kind', 'status'], _count: { _all: true } })) out[g.kind][g.status] = g._count._all;
    return out;
  }

  async get(): Promise<AdminStatusWire> {
    const [total, disabled, dataDisk, metaDisk, meta, jobs, reachable, version] = await Promise.all([
      this.prisma.user.count(), this.prisma.user.count({ where: { disabledAt: { not: null } } }),
      this.disk(this.config.dataRoot), this.disk(this.config.metaRoot), this.metaSizes(), this.jobs(), this.officeReachable(),
      this.updates.info(),
    ]);
    return {
      version, uptimeSec: Math.round(process.uptime()),
      watch: this.watcher.mode, lastFullScanAt: this.scheduler.lastFullScanAt?.toISOString() ?? null,
      users: { total, disabled }, disk: { data: dataDisk, meta: metaDisk }, meta, jobs,
      office: { enabled: !!this.config.officeUrl, reachable }, versions: this.config.versions,
    };
  }
}
