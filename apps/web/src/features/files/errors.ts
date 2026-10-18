import { ApiError } from '@/lib/api';

const KNOWN = new Set([
  'name_conflict', 'invalid_name', 'invalid_move', 'not_found', 'conflict', 'too_large', 'forbidden', 'unauthorized', 'network', 'server_error', 'upload_expired', 'space_unavailable', 'invalid_target', 'insufficient_storage',
]);

/** i18n key (`files.errors.<code>`) for a Sync API error code or a thrown error. */
export function errorKey(err: unknown): string {
  const code = err instanceof ApiError ? err.code : typeof err === 'string' ? err : err instanceof TypeError ? 'network' : 'unknown';
  return `files.errors.${KNOWN.has(code) ? code : 'unknown'}`;
}
