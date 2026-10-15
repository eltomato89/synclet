import { Injectable } from '@nestjs/common';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const SHA_RE = /^[0-9a-f]{64}$/;

/** Content-addressed store for derivatives below `<metaRoot>/derived` (never inside the data root). */
@Injectable()
export class DerivedStore {
  readonly root: string;

  constructor(metaRoot: string) {
    this.root = path.join(metaRoot, 'derived');
  }

  pathFor(sha: string, kind: 'thumb', size: 256 | 1024): string;
  pathFor(sha: string, kind: 'poster'): string;
  pathFor(sha: string, kind: 'thumb' | 'poster', size?: 256 | 1024): string {
    if (!SHA_RE.test(sha)) throw new Error('invalid content hash');
    const dir = path.join(this.root, sha.slice(0, 2), sha);
    if (kind === 'poster') return path.join(dir, 'poster.webp');
    if (size !== 256 && size !== 1024) throw new Error('invalid thumbnail size');
    return path.join(dir, `thumb-${size}.webp`);
  }

  async has(file: string): Promise<boolean> {
    return stat(file).then((s) => s.isFile(), () => false);
  }

  /** Writes to a temp file next to the target and renames it into place. */
  async writeAtomic(file: string, data: Buffer): Promise<void> {
    const rel = path.relative(this.root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path outside derived store');
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Deletes `<sha>` directories whose sha is not in the set returned by `liveShas` (given a batch of candidates;
   * the callback must cover live items, trashed manifests and versions). Returns the number of removed directories.
   */
  async gc(liveShas: (batch: string[]) => Promise<Set<string>>, batchSize = 500): Promise<number> {
    let removed = 0;
    const prefixes = await readdir(this.root).catch(() => [] as string[]);
    let batch: { sha: string; dir: string }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const live = await liveShas(batch.map((b) => b.sha));
      for (const b of batch) {
        if (live.has(b.sha)) continue;
        await rm(b.dir, { recursive: true, force: true });
        removed++;
      }
      batch = [];
    };
    for (const prefix of prefixes) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      const pdir = path.join(this.root, prefix);
      for (const sha of await readdir(pdir).catch(() => [] as string[])) {
        if (!SHA_RE.test(sha)) continue;
        batch.push({ sha, dir: path.join(pdir, sha) });
        if (batch.length >= batchSize) await flush();
      }
    }
    await flush();
    return removed;
  }
}
