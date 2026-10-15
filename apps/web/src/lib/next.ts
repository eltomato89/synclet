/** Only same-origin absolute paths are accepted as post-login targets (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/files'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (next.startsWith('/login') || next.startsWith('/setup')) return fallback;
  return next;
}
