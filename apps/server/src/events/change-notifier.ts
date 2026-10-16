import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** Postgres channel the journal notifies on (payload = space id), see JournalService.record(). */
export const CHANGES_CHANNEL = 'synclet_changes';
/** Postgres channel for "the space list or rights of this user changed" (payload = user id), see notifyAccount(). */
export const ACCOUNT_CHANNEL = 'synclet_account';

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
  /** Sends a Postgres notification (`pg_notify`); used by notifyAccount(). */
  publish?: (channel: string, payload: string) => Promise<unknown>;
  /** Trailing-edge window: at most one callback per key (space or user) per window. */
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

/** Subscribers per key with a coalescing trailing-edge timer per key. */
class Fanout {
  readonly subs = new Map<string, Set<Callback>>();
  readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly coalesceMs: number, private readonly log: Logger) {}

  subscribe(key: string, cb: Callback): () => void {
    let set = this.subs.get(key);
    if (!set) this.subs.set(key, (set = new Set()));
    set.add(cb);
    return () => {
      const s = this.subs.get(key);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.subs.delete(key);
        const t = this.pending.get(key);
        if (t) clearTimeout(t);
        this.pending.delete(key);
      }
    };
  }

  notify(key: string): void {
    if (!this.subs.has(key) || this.pending.has(key)) return;
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      for (const cb of [...(this.subs.get(key) ?? [])]) {
        try { cb(); } catch (e) { this.log.warn(`change subscriber failed: ${(e as Error).message}`); }
      }
    }, this.coalesceMs));
  }

  clear(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}

/**
 * One dedicated LISTEN connection per server process. Fans `synclet_changes` notifications out to
 * the subscribers of the notified space, and `synclet_account` notifications to the subscribers of
 * the notified user, coalesced per key. After a reconnect every subscriber gets a synthetic
 * wake-up, because notifications sent while the connection was down are lost.
 */
export class ChangeNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ChangeNotifier.name);
  private readonly changes: Fanout;
  private readonly accounts: Fanout;
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
    this.changes = new Fanout(this.coalesceMs, this.log);
    this.accounts = new Fanout(this.coalesceMs, this.log);
  }

  onModuleInit(): void {
    if (this.opts.enabled === false) return;
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Registers `cb` for change wake-ups of `spaceId`; returns the unsubscribe function. */
  subscribe(spaceId: string, cb: Callback): () => void {
    return this.changes.subscribe(spaceId, cb);
  }

  /** Schedules a (coalesced) wake-up of `spaceId`'s subscribers. */
  notify(spaceId: string): void {
    this.changes.notify(spaceId);
  }

  /** Registers `cb` for "account changed" wake-ups of `userId`; returns the unsubscribe function. */
  subscribeAccount(userId: string, cb: Callback): () => void {
    return this.accounts.subscribe(userId, cb);
  }

  /**
   * Tells every server process that the space list or rights of these users changed (membership,
   * space created/removed/missing, group changes): their event streams send `account` and follow
   * the new space set. Collect the users *before* removing memberships or spaces.
   */
  async notifyAccount(userIds: string[]): Promise<void> {
    const publish = this.opts.publish;
    if (!publish) {
      for (const id of new Set(userIds)) this.accounts.notify(id); // no database: this process only
      return;
    }
    for (const id of new Set(userIds)) await publish(ACCOUNT_CHANNEL, id);
  }

  /** Wakes every subscriber (after a reconnect: notifications may have been missed). */
  wakeAll(): void {
    for (const key of this.changes.subs.keys()) this.changes.notify(key);
    for (const key of this.accounts.subs.keys()) this.accounts.notify(key);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.changes.clear();
    this.accounts.clear();
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
      else if (msg.channel === ACCOUNT_CHANNEL && msg.payload) this.accounts.notify(msg.payload);
    });
    client.on('error', (err) => onLost(err));
    client.on('end', () => onLost());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANGES_CHANNEL}; LISTEN ${ACCOUNT_CHANNEL}`);
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
