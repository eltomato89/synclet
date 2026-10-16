import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { AsyncSubscription } from '@parcel/watcher';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { isIgnored } from '../common/names';
import { parentRel } from '../common/paths';
import type { IndexSpace } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { SpacesRepo } from '../spaces/spaces.repo';
import { DirDebouncer } from './debounce';
import { IndexerService } from './indexer.service';

export interface RawEvent { type: 'create' | 'update' | 'delete'; path: string }

@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WatcherService.name);
  mode: 'active' | 'scan-only' | 'off' = 'off';
  private users = new Map<string, IndexSpace>(); // username -> personal space
  private sub?: AsyncSubscription;
  private readonly debouncer: DirDebouncer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
    private readonly spaces: SpacesRepo,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.debouncer = new DirDebouncer(async (key, recursive) => {
      const [username, dir] = key.split('\u0000');
      const space = this.users.get(username);
      if (!space) return;
      try {
        await this.indexer.reconcileDir(space, dir, { recursive });
      } catch (e) {
        this.log.warn(`reconcile ${username}/${dir} failed: ${(e as Error).message}`);
      }
    });
    this.events.on('user.created', (u) => {
      void this.spaces.personalFor(u.id).then((space) => { this.users.set(u.username, space); }, () => {});
    });
  }

  async refreshUsers(): Promise<void> {
    const rows = await this.prisma.space.findMany({
      where: { kind: 'personal', user: { disabledAt: null } },
      select: { id: true, kind: true, rootPath: true, name: true },
    });
    this.users = new Map(rows.map((r) => [r.name, this.spaces.toIndexSpace(r)]));
  }

  async onApplicationBootstrap() {
    await this.refreshUsers();
  }

  /**
   * Subscribes to file events. Called by SchedulerService after startup recovery (temp cleanup,
   * staged-trash recovery) – never from a lifecycle hook: Nest runs a module's bootstrap hooks
   * concurrently, and a reconcile during recovery would journal deletes for vacated entries.
   */
  async start(): Promise<void> {
    if (!this.config.background || this.sub) return;
    if (!this.config.watch) { this.mode = 'scan-only'; return; }
    try {
      const watcher = await import('@parcel/watcher');
      this.sub = await watcher.subscribe(this.config.dataRoot, (err, events) => {
        if (err) {
          if (this.mode === 'active') this.log.error(`watcher error, falling back to periodic scans: ${err.message}`);
          this.mode = 'scan-only';
          return;
        }
        this.handleEvents(events);
      }, { ignore: ['**/.synclet-tmp-*', '**/.synclet-trash-*'] });
      this.mode = 'active';
    } catch (e) {
      // Typical cause: inotify watch limit (raise fs.inotify.max_user_watches on the host).
      this.log.error(`file watcher unavailable, falling back to periodic scans: ${(e as Error).message}`);
      this.mode = 'scan-only';
    }
  }

  handleEvents(events: RawEvent[]): void {
    for (const ev of events) {
      const rel = path.relative(this.config.dataRoot, ev.path).split(path.sep).join('/');
      if (rel === '..' || rel.startsWith('../') || rel === '') continue;
      const [username, ...rest] = rel.split('/');
      if (!this.users.has(username) || rest.length === 0) continue;
      if (rest.some((seg) => isIgnored(seg))) continue;
      const itemRel = rest.join('/');
      this.debouncer.push(`${username}\u0000${parentRel(itemRel)}`, false);
      if (ev.type === 'create') this.debouncer.push(`${username}\u0000${itemRel}`, true); // new dirs: scan contents
    }
  }

  flush(): Promise<void> { return this.debouncer.flushAll(); }

  async onModuleDestroy() {
    this.debouncer.stop();
    await this.sub?.unsubscribe();
    this.sub = undefined;
  }
}
