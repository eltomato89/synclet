import { constants } from 'node:fs';
import { copyFile, cp, link, lstat, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { nameKey } from '../common/names';

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const eexist = (dst: string) => Object.assign(new Error(`EEXIST: ${dst}`), { code: 'EEXIST' });

export async function statEntry(abs: string) {
  const st = await lstat(abs, { bigint: true });
  return { size: st.isDirectory() ? 0n : st.size, mtime: new Date(Number(st.mtimeMs)), ino: st.ino, dev: st.dev };
}

async function lstatOrNull(p: string) {
  return lstat(p, { bigint: true }).catch((e) => (code(e) === 'ENOENT' ? null : Promise.reject(e)));
}

/** Atomically publishes `src` at `dst` without ever replacing an existing `dst`. `src` stays (caller unlinks). */
export async function linkNoReplace(src: string, dst: string): Promise<void> {
  try {
    await link(src, dst);
  } catch (e) {
    if (code(e) === 'EEXIST') throw eexist(dst);
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(code(e) ?? '')) throw e;
    // File system without hard links (exFAT, some SMB) or a mount point in between:
    // exclusive copy (never replaces), keeping the source mtime; no partial file on failure.
    try {
      await copyFile(src, dst, constants.COPYFILE_EXCL);
    } catch (err) {
      if (code(err) === 'EEXIST') throw eexist(dst);
      await rm(dst, { force: true });
      throw err;
    }
    const st = await lstat(src);
    await utimes(dst, st.atime, st.mtime);
  }
}

/**
 * Renames without replacing an existing target (small TOCTOU window against host processes;
 * Node has no renameat2). An existing `dst` is only accepted when it is `src` itself seen through
 * a case/normalization-insensitive file system (APFS, SMB), i.e. a case-only rename in place.
 * On case-sensitive file systems a differently-cased sibling is a real file and is never clobbered.
 */
export async function moveNoReplace(src: string, dst: string): Promise<void> {
  const existing = await lstatOrNull(dst);
  if (existing) {
    const s = await lstat(src, { bigint: true });
    const sameEntry =
      s.ino === existing.ino && s.dev === existing.dev &&
      path.dirname(src) === path.dirname(dst) && nameKey(path.basename(src)) === nameKey(path.basename(dst));
    if (!sameEntry) throw eexist(dst);
  }
  await rename(src, dst);
}

/** Moves a file or folder, falling back to copy + delete across file systems (e.g. /data -> /meta). */
export async function moveAcrossFs(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e;
    await cp(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rm(src, { recursive: true, force: true });
  }
}
