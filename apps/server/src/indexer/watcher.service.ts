import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { AsyncSubscription } from '@parcel/watcher';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { isIgnored } from '../common/names';
import { isRealDir, parentRel, userRoot } from '../common/paths';
import type { IndexSpace } from '../common/types';
import { SpacesRepo } from '../spaces/spaces.repo';
import { DirDebouncer } from './debounce';
import { IndexerService } from './indexer.service';

export interface RawEvent { type: 'create' | 'update' | 'delete'; path: string }

const IGNORE = ['**/.synclet-tmp-*', '**/.synclet-trash-*'];

/**
 * File events → debounced directory reconciles, per space (spec §2.3). Subscriptions: the data
 * root (first segment = folder of a personal space), the teams root (first segment = team folder)
 * and every external storage with `watch auto` on its own. Routing goes through a root → space
 * table keyed by space id; unknown paths are ignored. A failing subscription leaves the spaces
 * below it scan-only (periodic scans still cover them).
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WatcherService.name);
  /** State of the data root subscription (reported in the admin status). */
  mode: 'active' | 'scan-only' | 'off' = 'off';
  /** Routable spaces by id. */
  private spaces = new Map<string, IndexSpace>();
  /** Parent folder (data root, teams root) → first path segment → space id. */
  private bySegment = new Map<string, Map<string, string>>();
  /** External storage root → space id (watch auto only). */
  private externals = new Map<string, string>();
  /** Watched folders and their subscriptions; `healthy` holds those without a reported error. */
  private readonly subs = new Map<string, AsyncSubscription>();
  private readonly healthy = new Set<string>();
  private started = false;
  private refreshing: Promise<void> = Promise.resolve();
  private readonly debouncer: DirDebouncer;

  constructor(
    private readonly indexer: IndexerService,
    private readonly spacesRepo: SpacesRepo,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.debouncer = new DirDebouncer(async (key, recursive) => {
      const [spaceId, dir] = key.split('\u0000');
      const space = this.spaces.get(spaceId);
      if (!space) return;
      try {
        await this.indexer.reconcileDir(space, dir, { recursive });
      } catch (e) {
        this.log.warn(`reconcile ${space.rootPath}/${dir} failed: ${(e as Error).message}`);
      }
    });
    // Synchronous: events for the new user's folder may arrive right after this.
    this.events.on('user.created', (u) => {
      this.route({ id: u.id, kind: 'personal', rootPath: userRoot(this.config.dataRoot, u.username) });
    });
    this.events.on('spaces.changed', () => {
      void this.refresh().catch((e) => this.log.warn(`space refresh failed: ${(e as Error).message}`));
    });
  }

  /** Rebuilds the routing table from the database and (once started) the external subscriptions. */
  refresh(): Promise<void> {
    const run = this.refreshing.then(() => this.refreshNow());
    this.refreshing = run.catch(() => undefined);
    return run;
  }

  private async refreshNow(): Promise<void> {
    const rows = await this.spacesRepo.indexable();
    this.spaces = new Map();
    this.bySegment = new Map();
    this.externals = new Map();
    for (const r of rows) {
      if (r.space.kind !== 'personal' && r.watch === 'off') continue; // scan-only
      this.route(r.space);
    }
    if (this.started && this.config.watch) await this.syncExternalSubs();
  }

  private route(space: IndexSpace): void {
    this.spaces.set(space.id, space);
    if (space.kind === 'external') { this.externals.set(space.rootPath, space.id); return; }
    const parent = path.dirname(space.rootPath);
    (this.bySegment.get(parent) ?? this.bySegment.set(parent, new Map()).get(parent)!).set(path.basename(space.rootPath), space.id);
  }

  async onApplicationBootstrap() {
    await this.refresh();
  }

  /**
   * Subscribes to file events. Called by SchedulerService after startup recovery (temp cleanup,
   * staged-trash recovery) – never from a lifecycle hook: Nest runs a module's bootstrap hooks
   * concurrently, and a reconcile during recovery would journal deletes for vacated entries.
   */
  async start(): Promise<void> {
    if (!this.config.background || this.started) return;
    this.started = true;
    if (!this.config.watch) { this.mode = 'scan-only'; return; }
    // Typical failure cause: inotify watch limit (raise fs.inotify.max_user_watches on the host).
    this.mode = (await this.watch(this.config.dataRoot)) ? 'active' : 'scan-only';
    if (await isRealDir(this.config.teamsRoot)) await this.watch(this.config.teamsRoot);
    await this.syncExternalSubs();
  }

  /** 'active' when events of the space arrive through a healthy subscription, else 'scan-only'. */
  watchModeOf(spaceId: string): 'active' | 'scan-only' {
    const space = this.spaces.get(spaceId);
    if (!space) return 'scan-only';
    const dir = space.kind === 'external' ? space.rootPath : path.dirname(space.rootPath);
    return this.healthy.has(dir) ? 'active' : 'scan-only';
  }

  /** Subscription seam (spied on in tests). */
  protected async subscribe(dir: string, onEvents: (err: Error | null, events: RawEvent[]) => void): Promise<AsyncSubscription> {
    const watcher = await import('@parcel/watcher');
    return watcher.subscribe(dir, onEvents, { ignore: IGNORE });
  }

  private async watch(dir: string): Promise<boolean> {
    if (this.subs.has(dir)) return this.healthy.has(dir);
    try {
      const sub = await this.subscribe(dir, (err, events) => {
        if (err) {
          if (this.healthy.delete(dir)) this.log.error(`watcher error on ${dir}, falling back to periodic scans: ${err.message}`);
          if (dir === this.config.dataRoot) this.mode = 'scan-only';
          return;
        }
        this.handleEvents(events);
      });
      this.subs.set(dir, sub);
      this.healthy.add(dir);
      return true;
    } catch (e) {
      this.log.error(`file watcher unavailable for ${dir}, falling back to periodic scans: ${(e as Error).message}`);
      return false;
    }
  }

  private async syncExternalSubs(): Promise<void> {
    const wanted = new Set(this.externals.keys());
    const fixed = new Set([this.config.dataRoot, this.config.teamsRoot]);
    for (const [dir, sub] of [...this.subs]) {
      if (fixed.has(dir) || wanted.has(dir)) continue;
      this.subs.delete(dir);
      this.healthy.delete(dir);
      await sub.unsubscribe().catch(() => {});
    }
    for (const dir of wanted) {
      if (!this.subs.has(dir)) await this.watch(dir);
    }
  }

  /** Maps an absolute path to its space and the path relative to the space root. */
  private resolve(abs: string): { spaceId: string; rel: string } | null {
    for (const [root, spaceId] of this.externals) {
      const rel = inside(root, abs);
      if (rel !== null) return { spaceId, rel };
    }
    for (const [parent, segs] of this.bySegment) {
      const rel = inside(parent, abs);
      if (!rel) continue;
      const [first, ...rest] = rel.split('/');
      const spaceId = segs.get(first);
      if (spaceId) return { spaceId, rel: rest.join('/') };
    }
    return null;
  }

  handleEvents(events: RawEvent[]): void {
    for (const ev of events) {
      const hit = this.resolve(ev.path);
      if (!hit || hit.rel === '') continue;
      if (hit.rel.split('/').some((seg) => isIgnored(seg))) continue;
      this.debouncer.push(`${hit.spaceId}\u0000${parentRel(hit.rel)}`, false);
      if (ev.type === 'create') this.debouncer.push(`${hit.spaceId}\u0000${hit.rel}`, true); // new dirs: scan contents
    }
  }

  flush(): Promise<void> { return this.debouncer.flushAll(); }

  async onModuleDestroy() {
    this.debouncer.stop();
    const subs = [...this.subs.values()];
    this.subs.clear();
    this.healthy.clear();
    this.started = false;
    for (const s of subs) await s.unsubscribe().catch(() => {});
  }
}

/** `abs` relative to `root` ('/'-separated; '' for the root itself), or null when outside. */
function inside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
