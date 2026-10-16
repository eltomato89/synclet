import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { SyncError } from '../common/sync-error';

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

  /** Seconds until the next token is available for `key` (0 when one is available now). */
  retryAfterSec(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const tokens = Math.min(this.opts.capacity, b.tokens + ((this.now() - b.at) / 1000) * this.opts.refillPerSec);
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / this.opts.refillPerSec);
  }
}

/** Shared limiters for unauthenticated endpoints (login, setup, public share password checks). */
@Injectable()
export class RateLimits {
  /** Per client IP, every attempt (CPU guard): 10 burst, one more per 6 s. */
  readonly ip = new RateLimiter({ capacity: 10, refillPerSec: 1 / 6 });
  /** Per (client IP + normalized login), failed password checks only: 10 burst, one more per 30 s. */
  readonly login = new RateLimiter({ capacity: 10, refillPerSec: 1 / 30 });

  /** Throws 429 rate_limited (and sets Retry-After) when the per-IP bucket is empty. `ip` is an `ipKey()`. */
  takeIp(ip: string, reply: FastifyReply): void {
    if (!this.ip.take(ip)) throw this.limited(this.ip, ip, reply);
  }

  limited(limiter: RateLimiter, key: string, reply: FastifyReply): SyncError {
    reply.header('Retry-After', String(Math.max(1, limiter.retryAfterSec(key))));
    return new SyncError('rate_limited', 'too many attempts, try again later');
  }
}
