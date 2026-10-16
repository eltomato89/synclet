import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Root folder of a personal space (only used to create and locate personal roots). */
export function userRoot(dataRoot: string, username: string): string {
  return path.join(dataRoot, username);
}

export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** Absolute path of `rel` below the space root `root`. Throws on traversal attempts. */
export function absPath(root: string, rel: string): string {
  if (rel === '') return root;
  const segments = rel.split('/');
  if (rel.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe relative path: ${rel}`);
  }
  return path.join(root, ...segments);
}

/** Resolves symlinks and asserts the target stays inside `root`. Returns the real path. */
export async function realpathInside(abs: string, root: string): Promise<string> {
  const [realTarget, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes root: ${abs}`);
  }
  return realTarget;
}
