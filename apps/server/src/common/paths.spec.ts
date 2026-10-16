import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absPath, baseName, joinRel, parentRel, realpathInside, userRoot } from './paths';

describe('paths', () => {
  it('joins and splits relative paths', () => {
    expect(joinRel('', 'a')).toBe('a');
    expect(joinRel('a/b', 'c')).toBe('a/b/c');
    expect(parentRel('a/b/c')).toBe('a/b');
    expect(parentRel('a')).toBe('');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
  });

  it('builds absolute paths below the space root', () => {
    expect(absPath(path.join('/data', 'alice'), '')).toBe(path.join('/data', 'alice'));
    expect(absPath(path.join('/data', 'alice'), 'x/y.txt')).toBe(path.join('/data', 'alice', 'x', 'y.txt'));
    expect(userRoot('/data', 'alice')).toBe(path.join('/data', 'alice'));
  });

  it('rejects traversal segments', () => {
    expect(() => absPath(path.join('/data', 'alice'), '../bob')).toThrow();
    expect(() => absPath(path.join('/data', 'alice'), 'a/../../x')).toThrow();
    expect(() => absPath(path.join('/data', 'alice'), 'a/./b')).toThrow();
    expect(() => absPath(path.join('/data', 'alice'), '/etc')).toThrow();
  });

  it('realpathInside rejects symlink escapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'synclet-paths-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'synclet-outside-'));
    await writeFile(path.join(outside, 'secret'), 'x');
    await mkdir(path.join(root, 'ok'));
    await symlink(outside, path.join(root, 'evil'));
    await expect(realpathInside(path.join(root, 'ok'), root)).resolves.toBeTruthy();
    await expect(realpathInside(path.join(root, 'evil', 'secret'), root)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});
