import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyNoReplace, linkNoReplace, moveNoReplace, replaceAtomic } from './fs-ops';

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
