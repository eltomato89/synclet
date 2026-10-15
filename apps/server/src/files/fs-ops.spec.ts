import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkNoReplace, moveNoReplace } from './fs-ops';

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
