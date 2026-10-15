export interface RateLimiterOptions {
  capacity: number;
  refillPerSec: number;
  /** LRU bound on tracked keys (default 10 000). */
  maxKeys?: number;
}

/** In-memory token bucket per key. Least recently used keys are evicted beyond `maxKeys`. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly maxKeys: number;

  constructor(private readonly opts: RateLimiterOptions, private readonly now: () => number = Date.now) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Consumes one token; false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.opts.capacity, at: now };
    b.tokens = Math.min(this.opts.capacity, b.tokens + ((now - b.at) / 1000) * this.opts.refillPerSec);
    b.at = now;
    this.buckets.delete(key); // re-insert: Map order = recency
    this.buckets.set(key, b);
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value as string);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  reset(key: string): void { this.buckets.delete(key); }
}
