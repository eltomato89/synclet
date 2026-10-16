import { SyncError } from './sync-error';

/** The server's disk (or the user's disk quota) is full: HTTP 507, clients retry later and tell the user. */
export class InsufficientStorageError extends SyncError {
  constructor(message = 'insufficient storage') {
    super('insufficient_storage', message);
  }
}

/** True for a full disk (ENOSPC) or an exceeded disk quota (EDQUOT). */
export const isStorageFull = (err: unknown): boolean => {
  const c = (err as { code?: unknown } | null | undefined)?.code;
  return c === 'ENOSPC' || c === 'EDQUOT';
};

/** Maps ENOSPC/EDQUOT to InsufficientStorageError; anything else is rethrown unchanged. Call after temp-file cleanup. */
export function rethrowStorageError(err: unknown): never {
  if (isStorageFull(err) && !(err instanceof InsufficientStorageError)) throw new InsufficientStorageError();
  throw err;
}
