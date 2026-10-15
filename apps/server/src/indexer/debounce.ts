interface Pending { recursive: boolean; timer: NodeJS.Timeout; firstAt: number }

/** Per-key debounce: runs after `quietMs` without new events, but at most `maxMs` after the first one. */
export class DirDebouncer {
  private readonly pending = new Map<string, Pending>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly run: (key: string, recursive: boolean) => Promise<void>, private readonly quietMs = 2000, private readonly maxMs = 10000) {}

  push(key: string, recursive: boolean): void {
    const now = Date.now();
    const p = this.pending.get(key);
    if (p) clearTimeout(p.timer);
    const firstAt = p?.firstAt ?? now;
    const wait = Math.max(0, Math.min(this.quietMs, firstAt + this.maxMs - now));
    const entry: Pending = { recursive: recursive || (p?.recursive ?? false), firstAt, timer: setTimeout(() => this.fire(key), wait) };
    this.pending.set(key, entry);
  }

  private fire(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    // Serialize runs: reconciles of one server never overlap (they lock per user anyway).
    this.running = this.running.then(() => this.run(key, p.recursive)).catch(() => {});
  }

  async flushAll(): Promise<void> {
    for (const [key, p] of [...this.pending]) { clearTimeout(p.timer); this.fire(key); }
    await this.running;
  }

  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
