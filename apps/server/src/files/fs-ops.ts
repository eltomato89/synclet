import { randomBytes } from 'node:crypto';
import { cp, link, lstat, mkdir, open, readdir, rename, rm, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { nameKey, tempName } from '../common/names';

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const eexist = (dst: string) => Object.assign(new Error(`EEXIST: ${dst}`), { code: 'EEXIST' });
export const NO_HARDLINK = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'];

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
 * Moves `src` to `dst` without ever replacing an existing `dst`.
 * - Files: link(2) + unlink(2), which refuses an existing `dst` atomically; on file systems without
 *   hard links: existence check + rename (small TOCTOU window against host processes).
 * - Folders: existence check + rename (rename(2) can at worst replace an *empty* directory).
 * An existing `dst` is only accepted when it is `src` itself seen through a case/normalization-
 * insensitive file system (APFS, SMB), i.e. a case-only rename in place. On case-sensitive file
 * systems a differently-cased sibling is a real file and is never clobbered.
 * Throws EXDEV unchanged when `src` and `dst` are on different file systems.
 */
export async function moveNoReplace(src: string, dst: string): Promise<void> {
  const s = await lstat(src, { bigint: true });
  const existing = await lstatOrNull(dst);
  if (existing) {
    const sameEntry =
      s.ino === existing.ino && s.dev === existing.dev &&
      path.dirname(src) === path.dirname(dst) && nameKey(path.basename(src)) === nameKey(path.basename(dst));
    if (!sameEntry) throw eexist(dst);
    await rename(src, dst); // case-only rename of the same entry
    return;
  }
  if (s.isFile()) {
    try {
      await link(src, dst);
    } catch (e) {
      if (code(e) === 'EEXIST') throw eexist(dst);
      if (code(e) === 'EXDEV' || !NO_HARDLINK.includes(code(e) ?? '')) throw e;
      if (await lstatOrNull(dst)) throw eexist(dst);
      await rename(src, dst);
      return;
    }
    try {
      await unlink(src);
    } catch (e) {
      await unlink(dst).catch(() => {}); // our own second link to the same inode
      throw e;
    }
    return;
  }
  await rename(src, dst);
}

/**
 * Moves a file or folder without replacing an existing `dst`, falling back to copy + delete
 * across file systems (e.g. /data -> /meta). The copy goes to an ignored temp name
 * (`.synclet-tmp-<hex>`) next to `dst` and is published only when complete – no-replace (link for
 * files, checked rename for folders) – so an existing `dst` always means "fully copied" (crash
 * recovery relies on that) and a host-created `dst` is never overwritten. The source is removed last.
 * `move` replaces the same-file-system step (a test seam).
 */
export async function moveAcrossFs(src: string, dst: string, move: (src: string, dst: string) => Promise<void> = moveNoReplace): Promise<void> {
  try {
    await move(src, dst);
    return;
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e;
  }
  await copyThenRemove(src, dst);
}

/**
 * Copies a file or folder tree to the new path `dst` (refuses an existing `dst`), keeping
 * timestamps and symlinks verbatim. The caller owns `dst` and removes it on failure.
 */
export async function copyTree(src: string, dst: string): Promise<void> {
  await cp(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** Like copyNoReplace, but reports written bytes after every chunk. */
async function copyFileTracked(src: string, dst: string, onBytes?: (n: number) => void): Promise<void> {
  if (!onBytes) return copyNoReplace(src, dst);
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
        onBytes(bytesRead);
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

/**
 * Copies a file or folder tree to the new path `dst` (refuses an existing `dst`) for bulk copies:
 * file contents and mtimes like copyNoReplace (fsynced), folder mtimes set after their content,
 * symlinks and special files skipped (the index never follows them). `onBytes` gets the bytes
 * written so far in chunks; `signal` stops between two files (AbortError). The caller owns `dst`
 * and removes it on failure.
 */
export async function copyTreeTracked(src: string, dst: string, opts: { onBytes?(n: number): void; signal?: AbortSignal } = {}): Promise<void> {
  const walk = async (from: string, to: string): Promise<void> => {
    if (opts.signal?.aborted) throw abortError();
    const st = await lstat(from);
    if (st.isFile()) {
      await copyFileTracked(from, to, opts.onBytes);
      return;
    }
    if (!st.isDirectory()) return; // symlink, socket, device: not copied
    try {
      await mkdir(to, { mode: 0o777 });
    } catch (e) {
      if (code(e) === 'EEXIST') throw eexist(to);
      throw e;
    }
    for (const name of (await readdir(from)).sort()) await walk(path.join(from, name), path.join(to, name));
    await utimes(to, st.atime, st.mtime);
  };
  await walk(src, dst);
}

/** The cross-device half of `moveAcrossFs` (exported for tests): copy to an ignored temp, publish no-replace, remove `src`. */
export async function copyThenRemove(src: string, dst: string): Promise<void> {
  const partial = path.join(path.dirname(dst), tempName(randomBytes(8).toString('hex')));
  try {
    await copyTree(src, partial);
    const st = await lstat(partial);
    if (st.isDirectory()) {
      if (await lstatOrNull(dst)) throw eexist(dst);
      await rename(partial, dst);
    } else {
      try {
        await link(partial, dst);
      } catch (e) {
        if (code(e) === 'EEXIST') throw eexist(dst);
        if (!NO_HARDLINK.includes(code(e) ?? '')) throw e;
        if (await lstatOrNull(dst)) throw eexist(dst);
        await rename(partial, dst);
      }
    }
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
  await rm(src, { recursive: true, force: true });
}
