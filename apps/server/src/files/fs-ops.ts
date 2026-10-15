import { randomBytes } from 'node:crypto';
import { cp, link, lstat, open, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { nameKey, tempName } from '../common/names';

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const eexist = (dst: string) => Object.assign(new Error(`EEXIST: ${dst}`), { code: 'EEXIST' });
const NO_HARDLINK = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'];

export async function statEntry(abs: string) {
  const st = await lstat(abs, { bigint: true });
  return { size: st.isDirectory() ? 0n : st.size, mtime: new Date(Number(st.mtimeMs)), ino: st.ino, dev: st.dev };
}

async function lstatOrNull(p: string) {
  return lstat(p, { bigint: true }).catch((e) => (code(e) === 'ENOENT' ? null : Promise.reject(e)));
}

/**
 * Copies `src` to a new file `dst` (exclusive create), keeping the mtime, fsynced.
 * The source is opened first and `dst` is created with O_EXCL, so a failure can only ever
 * remove the file this call created itself (checked by inode) – never a pre-existing one.
 */
export async function copyNoReplace(src: string, dst: string): Promise<void> {
  const sfh = await open(src, 'r');
  try {
    const dfh = await open(dst, 'wx', 0o666).catch((e) => Promise.reject(code(e) === 'EEXIST' ? eexist(dst) : e));
    let ours: bigint | null = null;
    try {
      ours = (await dfh.stat({ bigint: true })).ino;
      const buf = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const { bytesRead } = await sfh.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        for (let off = 0; off < bytesRead;) off += (await dfh.write(buf, off, bytesRead - off)).bytesWritten;
      }
      const st = await sfh.stat();
      await dfh.utimes(st.atime, st.mtime);
      await dfh.sync();
      await dfh.close();
    } catch (e) {
      await dfh.close().catch(() => {});
      const now = await lstatOrNull(dst).catch(() => null);
      if (ours !== null && now && now.ino === ours) await unlink(dst).catch(() => {});
      throw e;
    }
  } finally {
    await sfh.close().catch(() => {});
  }
}

/** Atomically publishes `src` at `dst` without ever replacing an existing `dst`. `src` stays (caller unlinks). */
export async function linkNoReplace(src: string, dst: string): Promise<void> {
  try {
    await link(src, dst);
  } catch (e) {
    if (code(e) === 'EEXIST') throw eexist(dst);
    if (!NO_HARDLINK.includes(code(e) ?? '')) throw e;
    // File system without hard links (exFAT, some SMB) or a mount point in between.
    await copyNoReplace(src, dst);
  }
}

/**
 * Atomically replaces the file `dst` with `src` (rename). Across a mount point (EXDEV) the
 * content is first copied to an ignored temp name next to `dst`, then renamed over it.
 */
export async function replaceAtomic(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e;
    const near = path.join(path.dirname(dst), tempName(randomBytes(8).toString('hex')));
    try {
      await copyNoReplace(src, near);
      await rename(near, dst);
    } finally {
      await rm(near, { force: true });
    }
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

/**
 * Moves a file or folder, falling back to copy + delete across file systems (e.g. /data -> /meta).
 * The copy goes to `<dst>-partial-<hex>` and is renamed to `dst` only when complete, so an
 * existing `dst` always means "fully copied" (crash recovery relies on that). The source is
 * removed last.
 */
export async function moveAcrossFs(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e;
    const partial = `${dst}-partial-${randomBytes(6).toString('hex')}`;
    try {
      await cp(src, partial, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      await rename(partial, dst);
    } catch (err) {
      await rm(partial, { recursive: true, force: true });
      throw err;
    }
    await rm(src, { recursive: true, force: true });
  }
}
