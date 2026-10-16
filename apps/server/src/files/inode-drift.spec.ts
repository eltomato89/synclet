import { execFile } from 'node:child_process';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createTestApp, createTestUser, personalSpace, TestContext } from '../../test/context';
import type { IndexSpace } from '../common/types';
import { FilesService } from './files.service';

const run = promisify(execFile);

/**
 * R-inode: Docker Desktop (virtiofs) hands out a new inode for an unchanged file after a
 * rename-over. Same bytes, size and mtime with only a new inode must not count as a host edit.
 * Simulated here (works on any host) by replacing the file with a byte-identical copy.
 */
describe('inode-only changes (hash-confirmed)', () => {
  let ctx: TestContext; let files: FilesService; let space: IndexSpace;
  beforeEach(async () => {
    ctx = await createTestApp();
    files = ctx.app.get(FilesService);
    space = personalSpace(ctx, await createTestUser(ctx, 'anna'));
  });
  afterEach(async () => { await ctx.close(); });

  const body = (s: string) => Readable.from([Buffer.from(s)]);
  /** Puts a new inode under `rel` with the given bytes and the current mtime of the file. */
  const swapInode = async (rel: string, bytes?: string) => {
    const abs = path.join(space.rootPath, rel);
    const st = await stat(abs);
    const tmp = `${abs}.copy`;
    // cp -p / touch -r keep the mtime to the nanosecond (a JS Date would round it).
    if (bytes === undefined) {
      await run('cp', ['-p', abs, tmp]);
    } else {
      await writeFile(tmp, bytes);
      await run('touch', ['-r', abs, tmp]);
    }
    await rename(tmp, abs);
    expect((await stat(abs)).ino).not.toBe(st.ino);
  };

  it('a PUT with the previous If-Match succeeds without an extra version', async () => {
    const f = await files.upload(space, null, 'a.txt', body('one'), {});
    const v2 = await files.replaceContent(space, f.id, body('two'), { ifMatchVersion: f.version });
    await swapInode('a.txt');
    const v3 = await files.replaceContent(space, f.id, body('three'), { ifMatchVersion: v2.version });
    expect(v3.version).toBe(v2.version + 1);
    expect(await readFile(path.join(space.rootPath, 'a.txt'), 'utf8')).toBe('three');
    // The refresh itself journals nothing: only the three writes.
    expect(await ctx.prisma.fileChange.count({ where: { scopeId: space.id, itemId: f.id } })).toBe(3);
  });

  it('an office save of the same session base is not turned into a conflict copy', async () => {
    const f = await files.upload(space, null, 'a.docx', body('one'), {});
    await swapInode('a.docx');
    const res = await files.saveOfficeContent(space, f.id, body('edited'), { key: 'k1', baseVersion: f.version, conflictName: (n) => `c-${n}`, fallbackName: 'x' });
    expect(res).toMatchObject({ outcome: 'replaced', item: { id: f.id, version: f.version + 1 } });
  });

  it('different bytes with equal size and mtime on a new inode are still a host edit (412)', async () => {
    const f = await files.upload(space, null, 'a.txt', body('one'), {});
    await swapInode('a.txt', 'eno');
    await expect(files.replaceContent(space, f.id, body('two'), { ifMatchVersion: f.version })).rejects.toMatchObject({ code: 'conflict' });
    expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).version).toBe(f.version + 1);
  });

  it('without a stored content hash an inode change stays a conservative new version', async () => {
    const f = await files.upload(space, null, 'a.txt', body('one'), {});
    await ctx.prisma.item.update({ where: { id: f.id }, data: { contentHash: null } });
    await swapInode('a.txt');
    await expect(files.replaceContent(space, f.id, body('two'), { ifMatchVersion: f.version })).rejects.toMatchObject({ code: 'conflict' });
  });
});
