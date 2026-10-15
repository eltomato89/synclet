import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';

/** Background worker loop. Task 5 replaces the idle body with the derivative job processor. */
@Injectable()
export class WorkerRunner {
  private readonly log = new Logger(WorkerRunner.name);
  private stopping!: () => void;
  private readonly stopped = new Promise<void>((resolve) => { this.stopping = resolve; });

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Resolves once `stop()` has been called. */
  async run(): Promise<void> {
    this.log.log(`worker idle (concurrency ${this.config.workerConcurrency})`);
    await this.stopped;
  }

  stop(): void {
    this.stopping();
  }
}
