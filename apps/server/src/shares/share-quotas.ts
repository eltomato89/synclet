import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Transform } from 'node:stream';
import { SyncError } from '../common/sync-error';

/** 503 variant of rate_limited: the server (not the client) is at capacity. */
export class ShareBusyError extends SyncError {
  override readonly status = 503;
  constructor() {
    super('rate_limited', 'too many downloads in progress, try again later');
  }
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * In-memory capacity limits of the anonymous share API (per process; reset on restart):
 * concurrent ZIP streams per share and globally, and the bytes external uploads may add per
 * share within 24 h. Limits are plain fields so tests can lower them.
 */
@Injectable()
export class ShareQuotas {
  zipPerShare = 4;
  zipGlobal = 16;
  uploadBytesPerDay = 10 * 1024 ** 3;

  private zipTotal = 0;
  private readonly zipByShare = new Map<string, number>();
  private readonly uploads = new Map<string, { since: number; bytes: number }>();

  /** Reserves a ZIP slot or throws 503 rate_limited with Retry-After. Returns an idempotent release. */
  acquireZip(shareId: string, reply: FastifyReply): () => void {
    const mine = this.zipByShare.get(shareId) ?? 0;
    if (mine >= this.zipPerShare || this.zipTotal >= this.zipGlobal) {
      reply.header('Retry-After', '30');
      throw new ShareBusyError();
    }
    this.zipTotal++;
    this.zipByShare.set(shareId, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.zipTotal--;
      const n = (this.zipByShare.get(shareId) ?? 1) - 1;
      if (n <= 0) this.zipByShare.delete(shareId);
      else this.zipByShare.set(shareId, n);
    };
  }

  private window(shareId: string, now: number) {
    let w = this.uploads.get(shareId);
    if (!w || now - w.since >= DAY_MS) {
      w = { since: now, bytes: 0 };
      this.uploads.set(shareId, w);
    }
    return w;
  }

  /** Bytes the share may still receive in the current 24 h window. */
  uploadRemaining(shareId: string, now = Date.now()): number {
    return Math.max(0, this.uploadBytesPerDay - this.window(shareId, now).bytes);
  }

  /**
   * Checks the declared length against the budget (413 too_large) and returns a pass-through
   * that charges every received byte to the share and fails with 413 once the budget is spent,
   * so concurrent uploads cannot jointly exceed it.
   */
  meterUpload(shareId: string, declaredLength: number | null): Transform {
    if (this.uploadRemaining(shareId) <= 0 || (declaredLength !== null && declaredLength > this.uploadRemaining(shareId))) {
      throw new SyncError('too_large', 'upload budget of this link is used up for today');
    }
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        const w = this.window(shareId, Date.now());
        if (w.bytes + chunk.length > this.uploadBytesPerDay) {
          cb(new SyncError('too_large', 'upload budget of this link is used up for today'));
          return;
        }
        w.bytes += chunk.length;
        cb(null, chunk);
      },
    });
  }
}
