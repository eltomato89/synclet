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
 * inotify on Linux, named explicitly: the default backend first probes for watchman via popen(), and
 * without watchman installed that probe throws before its pclose(), leaving a `[sh] <defunct>` child.
 * Elsewhere (macOS dev) the platform default applies.
 */
const BACKEND = process.platform === 'linux' ? { backend: 'inotify' as const } : {};
const SUBSCRIBE_TIMEOUT_MS = 60_000;
const SHUTDOWN_UNSUBSCRIBE_MS = 3_000;

/**
 * File events → debounced directory reconciles, per space (spec §2.3). Subscriptions: the data
 * root (first segment = folder of a personal space), the teams root (first segment = team folder)
 * and every external storage with `watch auto` on its own. Routing goes through a root → space
 * table keyed by space id; unknown paths are ignored. A failing subscription leaves the spaces
 * below it scan-only (periodic scans still cover them).
 *
 * Subscriptions are set up in the background: startup, scans, shutdown and the API never wait for
 * a native watcher call. @parcel/watcher runs subscribe/unsubscribe on the libuv threadpool, and
 * on Linux all of them share one inotify backend whose mutex is held for a subscribe's whole tree
 * walk (very long on big network shares). Parallel calls would only queue on that mutex, each
 * blocking a threadpool worker (and with them fs, crypto, zlib, dns). So native calls run one at a
 * time, in the order data root, teams root, external storages (`serial`): a hanging walk delays
 * the subscriptions queued after it, but never the server, scans or other I/O.
 *
 * A subscribe still pending after `subscribeTimeoutMs` is logged and reported scan-only, but kept:
 * when it completes after all it is used (the periodic scan covers the gap either way, and
 * dropping it would only restart the same slow walk). A completed subscribe is checked against the
 * current state, so one completing after shutdown, after its storage was dropped or for a
 * superseded attempt is unsubscribed right away; queued attempts no longer wanted are skipped.
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WatcherService.name);
  /** State of the data root subscription (reported in the admin status). */
  mode: 'starting' | 'active' | 'scan-only' | 'off' = 'off';
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
  /**
   * Subscriptions still being set up (@parcel/watcher walks the whole tree first, which can take
   * very long on big network shares). The entry is the identity token checked when it settles.
   */
  private readonly pending = new Map<string, { done: Promise<void>; timedOut: boolean }>();
  /** After this, a pending subscription is reported and treated as scan-only (it may still complete). */
  subscribeTimeoutMs = SUBSCRIBE_TIMEOUT_MS;
  /** Longest wait for unsubscribes at shutdown (they queue behind a pending tree walk). */
  shutdownUnsubscribeMs = SHUTDOWN_UNSUBSCRIBE_MS;
  /** Tail of the native call queue (see the class comment). */
  private native: Promise<unknown> = Promise.resolve();

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
    if (this.started && this.config.watch) this.syncExternalSubs();
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
    this.mode = 'starting';
    this.watch(this.config.dataRoot);
    if (await isRealDir(this.config.teamsRoot)) this.watch(this.config.teamsRoot);
    this.syncExternalSubs();
  }

  /** Resolves once no subscription is pending any more (tests). */
  async whenSettled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()].map((p) => p.done));
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
    return watcher.subscribe(dir, onEvents, { ignore: IGNORE, ...BACKEND });
  }

  /** Runs a native watcher call after all queued ones (one at a time). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.native.then(fn);
    this.native = run.catch(() => undefined);
    return run;
  }

  /** Queues a subscription of `dir` (no-op when subscribed, queued or pending). */
  private watch(dir: string): void {
    if (this.subs.has(dir) || this.pending.has(dir)) return;
    const entry = { done: Promise.resolve(), timedOut: false };
    this.pending.set(dir, entry);
    entry.done = this.serial(() => this.subscribeNow(dir, entry))
      .catch((e) => this.log.warn(`file watcher setup for ${dir} failed: ${(e as Error).message}`));
  }

  private async subscribeNow(dir: string, entry: { timedOut: boolean }): Promise<void> {
    if (this.pending.get(dir) !== entry || !this.wanted(dir)) {
      if (this.pending.get(dir) === entry) this.pending.delete(dir); // dropped while queued
      return;
    }
    const timer = setTimeout(() => {
      if (this.pending.get(dir) !== entry) return;
      entry.timedOut = true;
      this.log.warn(`file watcher for ${dir} not ready after ${Math.round(this.subscribeTimeoutMs / 1000)} s, using periodic scans until it is (watchers queued after it wait)`);
      if (dir === this.config.dataRoot) this.mode = 'scan-only';
    }, this.subscribeTimeoutMs);
    timer.unref();
    let sub: AsyncSubscription | undefined;
    try {
      sub = await this.subscribe(dir, (err, events) => {
        if (err) {
          if (!sub || this.subs.get(dir) !== sub) return; // not (or no longer) in use
          if (this.healthy.delete(dir)) this.log.error(`watcher error on ${dir}, falling back to periodic scans: ${err.message}`);
          if (dir === this.config.dataRoot) this.mode = 'scan-only';
          return;
        }
        this.handleEvents(events);
      });
    } catch (e) {
      if (this.pending.get(dir) !== entry) return;
      this.pending.delete(dir);
      // Typical failure cause: inotify watch limit (raise fs.inotify.max_user_watches on the host).
      this.log.error(`file watcher unavailable for ${dir}, falling back to periodic scans: ${(e as Error).message}`);
      if (dir === this.config.dataRoot) this.mode = 'scan-only';
      return;
    } finally {
      clearTimeout(timer);
    }
    if (this.pending.get(dir) !== entry || !this.wanted(dir)) {
      if (this.pending.get(dir) === entry) this.pending.delete(dir);
      await sub.unsubscribe().catch(() => {}); // still inside the queue slot: nothing else holds the backend
      return;
    }
    this.pending.delete(dir);
    this.subs.set(dir, sub);
    this.healthy.add(dir);
    if (dir === this.config.dataRoot) this.mode = 'active';
    if (entry.timedOut) this.log.log(`file watcher for ${dir} is ready after all`);
  }

  /** Whether a subscription of `dir` is (still) wanted. */
  private wanted(dir: string): boolean {
    if (!this.started) return false;
    return dir === this.config.dataRoot || dir === this.config.teamsRoot || this.externals.has(dir);
  }

  /** Drops subscriptions of storages no longer watched and queues new ones; never waits for them. */
  private syncExternalSubs(): void {
    const wanted = new Set(this.externals.keys());
    const fixed = new Set([this.config.dataRoot, this.config.teamsRoot]);
    for (const [dir, sub] of [...this.subs]) {
      if (fixed.has(dir) || wanted.has(dir)) continue;
      this.subs.delete(dir);
      this.healthy.delete(dir);
      void this.serial(() => sub.unsubscribe()).catch((e) => this.log.warn(`unsubscribing ${dir} failed: ${(e as Error).message}`));
    }
    // Not awaited: a slow subscription (big network share) must not hold up the scan cycle.
    for (const dir of wanted) this.watch(dir);
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
    // Pending subscriptions are not awaited: queued ones are skipped, the running one unsubscribes
    // itself when it completes.
    this.pending.clear();
    this.started = false;
    // Not queued, but bounded: unsubscribes wait for the backend mutex while a tree walk runs.
    // One after another, so at most one threadpool worker blocks on it.
    let timer: NodeJS.Timeout | undefined;
    const all = subs.reduce<Promise<void>>((p, s) => p.then(() => s.unsubscribe()).catch(() => {}), Promise.resolve());
    await Promise.race([
      all,
      new Promise<void>((r) => { timer = setTimeout(r, this.shutdownUnsubscribeMs); timer.unref(); }),
    ]);
    clearTimeout(timer);
  }
}

/** `abs` relative to `root` ('/'-separated; '' for the root itself), or null when outside. */
function inside(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
