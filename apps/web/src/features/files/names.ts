// Client-side mirror of the server's name rules (apps/server/src/common/names.ts), so dialogs can
// explain a bad name before the request. The server stays authoritative.

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const IGNORED_EXACT = new Set([
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', '.localized',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', '@eaDir', '#recycle', 'lost+found',
]);
const IGNORED_PATTERNS = [/^\._/, /^~\$/, /^~WRL.*\.tmp$/i, /^\.~lock\..*#$/, /^\.synclet-tmp-[A-Za-z0-9]+$/];

export type NameError = 'empty' | 'forbidden_char' | 'trailing' | 'reserved' | 'too_long' | 'ignored';

export function validateName(name: string): NameError | null {
  if (name.length === 0 || name === '.' || name === '..') return 'empty';
  if (FORBIDDEN.test(name)) return 'forbidden_char';
  if (/[ .]$/.test(name)) return 'trailing';
  if (RESERVED.test(name)) return 'reserved';
  if (new TextEncoder().encode(name.normalize('NFC')).length > 255) return 'too_long';
  if (IGNORED_EXACT.has(name) || IGNORED_PATTERNS.some((p) => p.test(name))) return 'ignored';
  return null;
}

/** Length of the name without its extension (for preselecting in the rename field). */
export function baseNameLength(name: string, isFolder: boolean): number {
  if (isFolder) return name.length;
  const i = name.lastIndexOf('.');
  return i <= 0 ? name.length : i;
}
