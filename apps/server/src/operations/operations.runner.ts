import { Injectable } from '@nestjs/common';

/**
 * Executes operations in the server process (the worker mounts the data read-only).
 * Task 5 fills in claiming and execution; until then `kick` does nothing.
 */
@Injectable()
export class OperationsRunner {
  /** AbortControllers of operations running in this process. */
  protected readonly active = new Map<string, AbortController>();

  /** Looks for claimable operations soon (after create / resolve / a finished job). */
  kick(): void {}

  /** Stops a running operation of this process between two files (its status is already `cancelled`). */
  cancelRunning(id: string): void {
    this.active.get(id)?.abort();
  }

  /** Resolves when nothing is running and nothing claimable is queued (tests). */
  async idle(): Promise<void> {}
}
