// Name rules shared by API writes, the indexer and the serializer.
// Display names follow Buro SYNC_API §4: unique per parent, case-insensitive, NFC.

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const IGNORED_EXACT = new Set([
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', '.localized',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', '@eaDir', '#recycle', 'lost+found',
]);
export const TEMP_PREFIX = '.synclet-tmp-';
const IGNORED_PATTERNS = [/^\._/, /^~\$/, /^~WRL.*\.tmp$/i, /^\.~lock\..*#$/, /^\.synclet-tmp-[A-Za-z0-9]+$/];

export type NameError = 'empty' | 'forbidden_char' | 'trailing' | 'reserved' | 'too_long' | 'ignored';

export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function isIgnored(name: string): boolean {
  return IGNORED_EXACT.has(name) || IGNORED_PATTERNS.some((p) => p.test(name));
}

export function tempName(id: string): string {
  return `${TEMP_PREFIX}${id}`;
}

export function isTempName(name: string): boolean {
  return /^\.synclet-tmp-[A-Za-z0-9]+$/.test(name);
}

export function validateName(name: string): NameError | null {
  if (name.length === 0 || name === '.' || name === '..') return 'empty';
  if (FORBIDDEN.test(name)) return 'forbidden_char';
  if (/[ .]$/.test(name)) return 'trailing';
  if (RESERVED.test(name)) return 'reserved';
  if (Buffer.byteLength(name.normalize('NFC'), 'utf8') > 255) return 'too_long';
  if (isIgnored(name)) return 'ignored';
  return null;
}

export function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

export function withSuffix(name: string, n: number, isFolder: boolean): string {
  if (isFolder) return `${name} (${n})`;
  const { base, ext } = splitExt(name);
  return `${base} (${n})${ext}`;
}

export function freeName(desired: string, takenKeys: Set<string>, isFolder: boolean): string {
  if (!takenKeys.has(nameKey(desired))) return desired;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(desired, n, isFolder);
    if (!takenKeys.has(nameKey(candidate))) return candidate;
  }
}

export interface NameSibling {
  id: string;
  name: string;
  type: 'folder' | 'file';
  createdAt: Date;
}

/** Deterministic, collision-free display names for all children of one parent. */
export function assignDisplayNames(siblings: NameSibling[]): Map<string, string> {
  const ranked = [...siblings].sort(
    (a, b) =>
      (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const taken = new Set<string>();
  const result = new Map<string, string>();
  const deferred: NameSibling[] = [];
  for (const s of ranked) {
    const k = nameKey(s.name);
    if (taken.has(k)) deferred.push(s);
    else { taken.add(k); result.set(s.id, s.name); }
  }
  for (const s of deferred) {
    const name = freeName(s.name, taken, s.type === 'folder');
    taken.add(nameKey(name));
    result.set(s.id, name);
  }
  return result;
}
