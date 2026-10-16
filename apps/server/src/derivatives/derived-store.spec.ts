import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DerivedStore } from './derived-store';

const sha = (c: string) => c.repeat(64);

describe('DerivedStore', () => {
  let meta: string;
  let store: DerivedStore;
  beforeEach(async () => {
    meta = await mkdtemp(path.join(os.tmpdir(), 'synclet-derived-'));
    store = new DerivedStore(meta);
  });
  afterEach(async () => {
    await chmod(path.join(meta, 'derived'), 0o755).catch(() => undefined);
    await rm(meta, { recursive: true, force: true });
  });

  it('lays out paths by sha prefix', () => {
    const s = 'ab' + 'c'.repeat(62);
    expect(store.pathFor(s, 'thumb', 256)).toBe(path.join(meta, 'derived', 'ab', s, 'thumb-256.webp'));
    expect(store.pathFor(s, 'thumb', 1024)).toBe(path.join(meta, 'derived', 'ab', s, 'thumb-1024.webp'));
    expect(store.pathFor(s, 'poster')).toBe(path.join(meta, 'derived', 'ab', s, 'poster.webp'));
  });

  it('rejects non-hex or malformed hashes', () => {
    for (const bad of ['../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '']) {
      expect(() => store.pathFor(bad, 'poster')).toThrow('invalid content hash');
    }
  });

  it('writes atomically and leaves no temp files', async () => {
    const p = store.pathFor(sha('a'), 'thumb', 256);
    expect(await store.has(p)).toBe(false);
    await store.writeAtomic(p, Buffer.from('x'));
    expect(await store.has(p)).toBe(true);
    expect(await readdir(path.dirname(p))).toEqual(['thumb-256.webp']);
  });

  it('leaves no temp files when the write fails', async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const p = store.pathFor(sha('b'), 'thumb', 256);
    await store.writeAtomic(p, Buffer.from('x'));
    await chmod(path.dirname(p), 0o555);
    await expect(store.writeAtomic(store.pathFor(sha('b'), 'poster'), Buffer.from('y'))).rejects.toThrow();
    await chmod(path.dirname(p), 0o755);
    expect(await readdir(path.dirname(p))).toEqual(['thumb-256.webp']);
  });

  it('refuses paths outside the store', async () => {
    await expect(store.writeAtomic(path.join(meta, 'elsewhere.webp'), Buffer.from('x'))).rejects.toThrow();
  });

  it('gc removes only unreferenced sha dirs and returns the count', async () => {
    for (const c of ['a', 'b', 'c']) await store.writeAtomic(store.pathFor(sha(c), 'poster'), Buffer.from(c));
    await mkdir(path.join(meta, 'derived', 'zz'), { recursive: true }); // foreign entry is ignored
    const seen: string[][] = [];
    const n = await store.gc(async (batch) => { seen.push(batch); return new Set([sha('b')]); });
    expect(n).toBe(2);
    expect(seen.flat().sort()).toEqual([sha('a'), sha('b'), sha('c')]);
    expect(await store.has(store.pathFor(sha('b'), 'poster'))).toBe(true);
    expect(await store.has(store.pathFor(sha('a'), 'poster'))).toBe(false);
    expect(await store.has(store.pathFor(sha('c'), 'poster'))).toBe(false);
  });

  it('gc on a missing root is a no-op', async () => {
    expect(await store.gc(async () => new Set())).toBe(0);
  });
});
