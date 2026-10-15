import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DerivativeJob } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config';
import { HashBackfill } from '../derivatives/hash';
import { JobsService } from '../derivatives/jobs.service';
import { BadInputError, Thumbnailer } from '../derivatives/thumbnails';

const IDLE_MS = 2000;

/**
 * Background worker loop: hash backfill → enqueue missing jobs → process claimed thumbnail jobs
 * concurrently. Loops immediately while there is work, otherwise sleeps IDLE_MS. `stop()` lets
 * in-flight jobs finish and hands unstarted claims back.
 */
@Injectable()
export class WorkerRunner {
  private readonly log = new Logger(WorkerRunner.name);
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly hash: HashBackfill,
    private readonly jobs: JobsService,
    private readonly thumbs: Thumbnailer,
  ) {}

  /** Resolves once `stop()` has been called and in-flight work is finished. */
  async run(): Promise<void> {
    this.log.log(`worker started (concurrency ${this.config.workerConcurrency})`);
    while (!this.stopping) {
      let worked = false;
      try {
        worked = await this.tick();
      } catch (e) {
        this.log.error(`worker loop: ${(e as Error).message}`);
      }
      if (!worked && !this.stopping) await this.sleep(IDLE_MS);
    }
    this.log.log('worker stopped');
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  /** One pass; true if anything was done (the next pass then starts without a pause). */
  async tick(): Promise<boolean> {
    const hashed = await this.hash.hashMissing(200, () => this.stopping);
    if (this.stopping) return hashed > 0;
    const enqueued = await this.jobs.enqueueMissing();
    if (this.stopping) return true;
    const claimed = await this.jobs.claim('thumb', Math.max(1, this.config.workerConcurrency));
    await Promise.all(claimed.map((job) => this.processThumb(job)));
    // Task 6 adds the `text` jobs here.
    return hashed > 0 || enqueued > 0 || claimed.length > 0;
  }

  async processThumb(job: DerivativeJob): Promise<void> {
    if (this.stopping) {
      await this.jobs.release(job.sha, job.kind);
      return;
    }
    try {
      const src = await this.jobs.sourceFor(job.sha, 'thumb');
      if (!src) {
        await this.jobs.drop(job.sha, job.kind);
        return;
      }
      const result = await this.thumbs.generateThumb(job, src);
      await this.jobs.complete(job.sha, job.kind, result.status, result.meta as object);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof BadInputError) {
        this.log.warn(`thumbnail ${job.sha.slice(0, 12)} failed: ${msg}`);
        await this.jobs.complete(job.sha, job.kind, 'failed', undefined, msg).catch(() => undefined);
      } else {
        this.log.warn(`thumbnail ${job.sha.slice(0, 12)} attempt ${job.attempts} failed: ${msg}`);
        await this.jobs.retryOrFail(job.sha, job.kind, msg).catch(() => undefined);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.wake = null; resolve(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
