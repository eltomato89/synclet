import type { ItemType } from '@prisma/client';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIgnored } from '../common/names';

export interface DiskEntry {
  name: string;
  type: ItemType;
  size: bigint;
  mtime: Date;
  ino: bigint;
  dev: bigint;
}

const CHUNK = 64;

/** Lists a directory: regular files and directories only, no symlinks, no ignored names, valid UTF-8 only. */
export async function readDisk(abs: string, log: (msg: string) => void = () => {}): Promise<DiskEntry[]> {
  const dirents = await readdir(abs, { withFileTypes: true, encoding: 'buffer' });
  const names: string[] = [];
  for (const d of dirents) {
    const raw = d.name as unknown as Buffer;
    const name = raw.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(raw)) { log(`skipping non-UTF-8 name in ${abs}`); continue; }
    if (isIgnored(name)) continue;
    if (!d.isFile() && !d.isDirectory()) continue;
    names.push(name);
  }
  const out: DiskEntry[] = [];
  for (let i = 0; i < names.length; i += CHUNK) {
    const stats = await Promise.all(
      names.slice(i, i + CHUNK).map(async (name) => {
        try {
          const st = await lstat(path.join(abs, name), { bigint: true });
          if (!st.isFile() && !st.isDirectory()) return null;
          const entry: DiskEntry = {
            name, type: st.isDirectory() ? 'folder' : 'file', size: st.isDirectory() ? 0n : st.size,
            mtime: new Date(Number(st.mtimeMs)), ino: st.ino, dev: st.dev,
          };
          return entry;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        }
      }),
    );
    for (const s of stats) if (s) out.push(s);
  }
  return out;
}
