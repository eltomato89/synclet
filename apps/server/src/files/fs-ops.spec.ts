import { mkdir, mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isIgnored, isTempName } from '../common/names';
import { copyNoReplace, copyThenRemove, linkNoReplace, moveAcrossFs, moveNoReplace, replaceAtomic } from './fs-ops';

it('linkNoReplace never clobbers an existing file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  await writeFile(path.join(dir, 'src'), 'new');
  await writeFile(path.join(dir, 'dst'), 'old');
  await expect(linkNoReplace(path.join(dir, 'src'), path.join(dir, 'dst'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(dir, 'dst'), 'utf8')).toBe('old');
  await linkNoReplace(path.join(dir, 'src'), path.join(dir, 'fresh'));
  expect(await readFile(path.join(dir, 'fresh'), 'utf8')).toBe('new');
});

it('moveNoReplace never clobbers a different entry but allows renaming onto itself', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  await writeFile(path.join(dir, 'a'), 'a');
  await writeFile(path.join(dir, 'b'), 'b');
  await expect(moveNoReplace(path.join(dir, 'a'), path.join(dir, 'b'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(dir, 'b'), 'utf8')).toBe('b');
  await moveNoReplace(path.join(dir, 'a'), path.join(dir, 'A'));
  expect((await readdir(dir)).sort()).toEqual(['A', 'b']);
});

it('copyNoReplace (no-hard-link fallback) never removes a pre-existing destination', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  await writeFile(path.join(dir, 'dst'), 'user file');
  // Source vanished (e.g. temp file deleted on the host): must fail without touching dst.
  await expect(copyNoReplace(path.join(dir, 'missing'), path.join(dir, 'dst'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(dir, 'dst'), 'utf8')).toBe('user file');
  await writeFile(path.join(dir, 'src'), 'new');
  await expect(copyNoReplace(path.join(dir, 'src'), path.join(dir, 'dst'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(dir, 'dst'), 'utf8')).toBe('user file');
});

it('copyNoReplace copies content and mtime to a fresh destination', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  const when = new Date('2024-05-01T10:00:00.000Z');
  await writeFile(path.join(dir, 'src'), 'payload');
  await utimes(path.join(dir, 'src'), when, when);
  await copyNoReplace(path.join(dir, 'src'), path.join(dir, 'fresh'));
  expect(await readFile(path.join(dir, 'fresh'), 'utf8')).toBe('payload');
  expect((await stat(path.join(dir, 'fresh'))).mtime.toISOString()).toBe(when.toISOString());
});

it('replaceAtomic replaces the destination content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  await writeFile(path.join(dir, 'src'), 'new');
  await writeFile(path.join(dir, 'dst'), 'old');
  await replaceAtomic(path.join(dir, 'src'), path.join(dir, 'dst'));
  expect(await readFile(path.join(dir, 'dst'), 'utf8')).toBe('new');
  expect((await readdir(dir)).sort()).toEqual(['dst']);
});

describe('cross-device move (copyThenRemove, the EXDEV half of moveAcrossFs)', () => {
  it('moves files and folders via an ignored temp name and removes the source', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
    await writeFile(path.join(dir, 'f'), 'file');
    await mkdir(path.join(dir, 'd'));
    await writeFile(path.join(dir, 'd', 'x'), 'x');
    await mkdir(path.join(dir, 'out'));
    await copyThenRemove(path.join(dir, 'f'), path.join(dir, 'out', 'f'));
    await copyThenRemove(path.join(dir, 'd'), path.join(dir, 'out', 'd'));
    expect((await readdir(dir)).sort()).toEqual(['out']);
    expect((await readdir(path.join(dir, 'out'))).sort()).toEqual(['d', 'f']);
    expect(await readFile(path.join(dir, 'out', 'd', 'x'), 'utf8')).toBe('x');
  });

  it('never overwrites an existing destination and leaves the source and no temp behind', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
    await writeFile(path.join(dir, 'f'), 'mine');
    await mkdir(path.join(dir, 'd'));
    await mkdir(path.join(dir, 'out'));
    await writeFile(path.join(dir, 'out', 'f'), 'host');
    await mkdir(path.join(dir, 'out', 'd'));
    await expect(copyThenRemove(path.join(dir, 'f'), path.join(dir, 'out', 'f'))).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(copyThenRemove(path.join(dir, 'd'), path.join(dir, 'out', 'd'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(dir, 'out', 'f'), 'utf8')).toBe('host');
    expect(await readFile(path.join(dir, 'f'), 'utf8')).toBe('mine');
    expect((await readdir(path.join(dir, 'out'))).sort()).toEqual(['d', 'f']);
  });

  it('uses temp names the indexer ignores', () => {
    expect(isIgnored('.synclet-tmp-0a1b2c3d4e5f6a7b')).toBe(true);
    expect(isTempName('.synclet-tmp-0a1b2c3d4e5f6a7b')).toBe(true);
  });
});

it('moveAcrossFs never overwrites an existing destination on the same file system', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  await writeFile(path.join(dir, 'a'), 'mine');
  await writeFile(path.join(dir, 'b'), 'host');
  await expect(moveAcrossFs(path.join(dir, 'a'), path.join(dir, 'b'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(dir, 'b'), 'utf8')).toBe('host');
  expect(await readFile(path.join(dir, 'a'), 'utf8')).toBe('mine');
});
