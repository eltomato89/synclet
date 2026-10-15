import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** Postgres channel the journal notifies on (payload = user id), see JournalService.record(). */
export const CHANGES_CHANNEL = 'synclet_changes';

/** The part of `pg.Client` the notifier uses (a fake in unit tests). */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
  /** Tears the socket down at once (a half-open connection never completes `end()`). */
  destroy?(): void;
  on(event: 'notification', cb: (msg: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
}

export interface ChangeNotifierOptions {
  /** Creates a fresh, unconnected client (one per connection attempt). */
  createClient: () => ListenClient;
  /** Trailing-edge window: at most one callback per user per window. */
  coalesceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Interval of the `SELECT 1` liveness check on the LISTEN connection. */
  healthIntervalMs?: number;
  /** A liveness check without an answer within this time counts as a lost connection. */
  healthTimeoutMs?: number;
  /** false: never connect (worker role). */
  enabled?: boolean;
}

type Callback = () => void;

/**
 * One dedicated LISTEN connection per server process. Fans `synclet_changes` notifications out to
 * the subscribers of the notified user, coalesced per user. After a reconnect every subscriber gets
 * a synthetic wake-up, because notifications sent while the connection was down are lost.
 */
export class ChangeNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ChangeNotifier.name);
  private readonly subs = new Map<string, Set<Callback>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private client: ListenClient | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly coalesceMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly healthIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private healthTimer: NodeJS.Timeout | null = null;
  private markReady!: () => void;
  /** Resolves after the first successful LISTEN (tests wait for it). */
  readonly ready = new Promise<void>((resolve) => { this.markReady = resolve; });

  constructor(private readonly opts: ChangeNotifierOptions) {
    this.coalesceMs = opts.coalesceMs ?? 250;
    this.minBackoffMs = opts.minBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.healthIntervalMs = opts.healthIntervalMs ?? 30_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 5000;
  }

  onModuleInit(): void {
    if (this.opts.enabled === false) return;
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Registers `cb` for change wake-ups of `userId`; returns the unsubscribe function. */
  subscribe(userId: string, cb: Callback): () => void {
    let set = this.subs.get(userId);
    if (!set) this.subs.set(userId, (set = new Set()));
    set.add(cb);
    return () => {
      const s = this.subs.get(userId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.subs.delete(userId);
        const t = this.pending.get(userId);
        if (t) clearTimeout(t);
        this.pending.delete(userId);
      }
    };
  }

  /** Schedules a (coalesced) wake-up of `userId`'s subscribers. */
  notify(userId: string): void {
    if (!this.subs.has(userId) || this.pending.has(userId)) return;
    this.pending.set(userId, setTimeout(() => {
      this.pending.delete(userId);
      for (const cb of [...(this.subs.get(userId) ?? [])]) {
        try { cb(); } catch (e) { this.log.warn(`change subscriber failed: ${(e as Error).message}`); }
      }
    }, this.coalesceMs));
  }

  /** Wakes every subscriber (after a reconnect: notifications may have been missed). */
  wakeAll(): void {
    for (const userId of this.subs.keys()) this.notify(userId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let client: ListenClient;
    try {
      client = this.opts.createClient();
    } catch (e) {
      // E.g. an unusable connection string: never an unhandled rejection, keep retrying.
      if (this.attempt === 0) this.log.error(`cannot create the LISTEN client: ${(e as Error).message}`);
      this.scheduleRetry();
      return;
    }
    this.client = client;
    let lost = false;
    const onLost = (err?: Error) => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = null;
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = null;
      client.destroy?.();
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      // Once per outage, not on every failed retry.
      if (this.attempt === 0) this.log.warn(`LISTEN connection lost${err ? `: ${err.message}` : ''}; reconnecting with backoff`);
      this.scheduleRetry();
    };
    client.on('notification', (msg) => {
      if (msg.channel === CHANGES_CHANNEL && msg.payload) this.notify(msg.payload);
    });
    client.on('error', (err) => onLost(err));
    client.on('end', () => onLost());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANGES_CHANNEL}`);
    } catch (e) {
      onLost(e as Error);
      return;
    }
    if (lost || this.stopped) return;
    if (this.attempt > 0) this.log.log('LISTEN connection restored');
    this.attempt = 0;
    this.markReady();
    // A LISTEN connection sends nothing on its own, so a silently dead peer (half-open TCP, a
    // restarted proxy) would go unnoticed: probe it.
    this.healthTimer = setInterval(() => void this.probe(client, onLost), this.healthIntervalMs);
    this.wakeAll();
  }

  private async probe(client: ListenClient, onLost: (err?: Error) => void): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer to the liveness check within ${this.healthTimeoutMs} ms`)), this.healthTimeoutMs);
    });
    try {
      await Promise.race([client.query('SELECT 1'), timeout]);
    } catch (e) {
      onLost(e as Error);
    } finally {
      clearTimeout(timer);
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    const delay = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
