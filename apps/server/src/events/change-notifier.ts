import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** Postgres channel the journal notifies on (payload = user id), see JournalService.record(). */
export const CHANGES_CHANNEL = 'synclet_changes';

/** The part of `pg.Client` the notifier uses (a fake in unit tests). */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
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

  constructor(private readonly opts: ChangeNotifierOptions) {
    this.coalesceMs = opts.coalesceMs ?? 250;
    this.minBackoffMs = opts.minBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
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
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = this.opts.createClient();
    this.client = client;
    let lost = false;
    const onLost = (err?: Error) => {
      if (lost) return;
      lost = true;
      if (this.client === client) this.client = null;
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
    this.wakeAll();
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
