import type { SyncItem } from '@synclet/shared';
import { ApiError } from '@/lib/api';
import { isIgnored, nameKey } from './names';

// Folder upload: a picked or dropped folder becomes a plan (folders + file targets), the folders
// are created on the server level by level, then every file goes into the normal upload queue
// with the id of its target folder.

/** Files and folders as relative paths (`Urlaub/Bilder/a.jpg`); loose files have no `/`. */
export interface Picked {
  files: { path: string; file: File }[];
  /** Every folder seen, including empty ones (`Urlaub`, `Urlaub/Bilder`). */
  folders: string[];
}

/** One top-level folder to upload. Paths are relative to it; `''` is the folder itself. */
export interface FolderTree {
  name: string;
  /** Sub-folders to create, parents before children. */
  folders: string[];
  files: { dir: string; file: File }[];
}

export interface UploadPlan {
  looseFiles: File[];
  trees: FolderTree[];
  /** System files left out (SYNC_API §4.3 ignore list). */
  skipped: number;
}

// ---- traversal --------------------------------------------------------------------------------

/** All entries of a directory: `readEntries` hands them out in batches until it returns none. */
export async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const out: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

const isDir = (e: FileSystemEntry): e is FileSystemDirectoryEntry => e.isDirectory;
const isFile = (e: FileSystemEntry): e is FileSystemFileEntry => e.isFile;

/** Walks dropped entries (from `DataTransferItem.webkitGetAsEntry`) recursively. */
export async function pickedFromEntries(entries: FileSystemEntry[]): Promise<Picked> {
  const picked: Picked = { files: [], folders: [] };
  async function walk(entry: FileSystemEntry, prefix: string): Promise<void> {
    const path = prefix + entry.name;
    if (isDir(entry)) {
      picked.folders.push(path);
      const children = await readAllEntries(entry.createReader());
      for (const child of children) await walk(child, `${path}/`);
    } else if (isFile(entry)) {
      const file = await new Promise<File>((ok, fail) => entry.file(ok, fail));
      picked.files.push({ path, file });
    }
  }
  for (const e of entries) await walk(e, '');
  return picked;
}

/**
 * Files and folders of a drop. The entries are taken synchronously – the DataTransfer is emptied
 * once the drop event returns – and walked afterwards. Without the entries API only the plain
 * files are available. `walk: false` lists dropped folders without reading them.
 */
export function pickedFromDataTransfer(dt: DataTransfer, { walk = true }: { walk?: boolean } = {}): Promise<Picked> {
  const items = Array.from(dt.items ?? []);
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const entries: FileSystemEntry[] = [];
    const loose: File[] = [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry();
      if (entry) entries.push(entry);
      else { const f = it.getAsFile(); if (f) loose.push(f); }
    }
    if (!walk) {
      return Promise.all(entries.filter(isFile).map((e) => new Promise<File>((ok, fail) => e.file(ok, fail)))).then((files) => ({
        files: [...files, ...loose].map((file) => ({ path: file.name, file })),
        folders: entries.filter(isDir).map((e) => e.name),
      }));
    }
    return pickedFromEntries(entries).then((p) => ({ ...p, files: [...p.files, ...loose.map((file) => ({ path: file.name, file }))] }));
  }
  return Promise.resolve({ files: Array.from(dt.files).map((file) => ({ path: file.name, file })), folders: [] });
}

/** A `<input webkitdirectory>` selection: every file carries `webkitRelativePath`. */
export function pickedFromInputFiles(files: File[]): Picked {
  const folders = new Set<string>();
  const out = files.map((file) => {
    const path = file.webkitRelativePath || file.name;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    return { path, file };
  });
  return { files: out, folders: [...folders] };
}

// ---- plan -------------------------------------------------------------------------------------

const depth = (p: string) => p.split('/').length;

/** Splits a selection into loose files and one tree per top-level folder; skips system files. */
export function buildPlan(picked: Picked): UploadPlan {
  const trees = new Map<string, { folders: Set<string>; files: { dir: string; file: File }[] }>();
  const looseFiles: File[] = [];
  let skipped = 0;

  const treeOf = (top: string) => {
    let t = trees.get(top);
    if (!t) { t = { folders: new Set(), files: [] }; trees.set(top, t); }
    return t;
  };
  /** Registers `parts` (relative to the tree, without the top folder) and its ancestors. */
  const addDirs = (top: string, parts: string[]) => {
    const t = treeOf(top);
    for (let i = 1; i <= parts.length; i++) t.folders.add(parts.slice(0, i).join('/'));
  };

  for (const { path, file } of picked.files) {
    const parts = path.split('/').filter(Boolean);
    if (parts.some(isIgnored)) { skipped++; continue; }
    if (parts.length === 1) { looseFiles.push(file); continue; }
    const [top, ...rest] = parts;
    const dirParts = rest.slice(0, -1);
    addDirs(top, dirParts);
    treeOf(top).files.push({ dir: dirParts.join('/'), file });
  }
  for (const path of picked.folders) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(isIgnored)) continue;
    const [top, ...rest] = parts;
    addDirs(top, rest);
  }

  return {
    looseFiles,
    skipped,
    trees: [...trees].map(([name, t]) => ({
      name,
      folders: [...t.folders].sort((a, b) => depth(a) - depth(b)),
      files: t.files,
    })),
  };
}

// ---- conflicts with the target folder ---------------------------------------------------------

export type ConflictChoice = 'merge' | 'rename' | 'cancel';
export interface ConflictQuestion {
  name: string;
  existingType: 'file' | 'folder';
  /** What "keep both" will most likely be called (the server decides). */
  keepName: string;
  /** Conflicts still to come after this one ("apply to all" is offered when > 0). */
  remaining: number;
}
export interface ConflictAnswer { choice: ConflictChoice; applyAll: boolean }
export interface TreeTarget { tree: FolderTree; mergeInto?: string }

/** The first free `"<name> (n)"` among `siblings`, n ≥ 2 (folder rule of SYNC_API §4.3). */
export function keepName(name: string, siblings: SyncItem[]): string {
  const taken = new Set(siblings.map((s) => nameKey(s.name)));
  let n = 2;
  while (taken.has(nameKey(`${name} (${n})`))) n++;
  return `${name} (${n})`;
}

/**
 * Asks per tree whose name already exists in the target folder: merge into the existing folder,
 * keep both ("(2)") or leave it out. "Apply to all" answers the remaining conflicts, except that a
 * merge cannot apply to an existing file – those are asked anyway.
 */
export async function resolveChoices(
  trees: FolderTree[], siblings: SyncItem[], ask: (q: ConflictQuestion) => Promise<ConflictAnswer>,
): Promise<TreeTarget[]> {
  const byKey = new Map(siblings.map((s) => [nameKey(s.name), s]));
  const existingOf = (t: FolderTree) => byKey.get(nameKey(t.name));
  const out: TreeTarget[] = [];
  let all: ConflictChoice | null = null;
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    const existing = existingOf(tree);
    if (!existing) { out.push({ tree }); continue; }
    const isFolder = existing.type === 'folder';
    let choice: ConflictChoice;
    if (all && (all !== 'merge' || isFolder)) {
      choice = all;
    } else {
      const remaining = trees.slice(i + 1).filter((t) => existingOf(t)).length;
      const answer = await ask({ name: tree.name, existingType: existing.type, keepName: keepName(tree.name, siblings), remaining });
      choice = answer.choice === 'merge' && !isFolder ? 'rename' : answer.choice;
      if (answer.applyAll) all = answer.choice;
    }
    if (choice === 'cancel') continue;
    out.push(choice === 'merge' ? { tree, mergeInto: existing.id } : { tree });
  }
  return out;
}

// ---- execution --------------------------------------------------------------------------------

export interface FolderUploadDeps {
  createFolder(parentId: string, name: string, onConflict: 'fail' | 'rename'): Promise<SyncItem>;
  listChildren(parentId: string): Promise<SyncItem[]>;
  enqueue(files: File[], parentId: string): void;
}
export interface FolderUploadHooks {
  /** The top folder exists (its real name may be "Urlaub (2)"). */
  onRoot?(item: { id: string; name: string }): void;
  /** True once the user cancelled: nothing more is created or enqueued. */
  cancelled?(): boolean;
}
export interface FolderError { path: string; code: string; files: number }
export interface FolderUploadResult { rootName: string; rootId?: string; errors: FolderError[]; cancelled?: boolean }

const CONCURRENCY = 4;

const codeOf = (e: unknown) => (e instanceof ApiError ? e.code : e instanceof TypeError ? 'network' : 'unknown');

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * A sub-folder of a merge: an existing folder with that name is reused (409 `name_conflict` with
 * the folder as `item`, or found by name when the server did not send it); an existing file with
 * that name makes the folder "<name> (2)".
 */
async function ensureFolder(deps: FolderUploadDeps, parentId: string, name: string): Promise<string> {
  try {
    return (await deps.createFolder(parentId, name, 'fail')).id;
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'name_conflict') throw e;
    let existing = e.item;
    if (!existing) existing = (await deps.listChildren(parentId)).find((s) => nameKey(s.name) === nameKey(name));
    if (existing?.type === 'folder') return existing.id;
    return (await deps.createFolder(parentId, name, 'rename')).id;
  }
}

/**
 * Creates the folders of `tree` below `parentId` (or inside `mergeInto`), parents first, and
 * enqueues every file into its folder. A folder that cannot be created is reported with the
 * number of files below it; its subtree is skipped, everything else continues.
 */
export async function uploadTree(
  tree: FolderTree, target: { parentId: string; mergeInto?: string }, deps: FolderUploadDeps, hooks: FolderUploadHooks = {},
): Promise<FolderUploadResult> {
  const filesBelow = (dir: string) => tree.files.filter((f) => f.dir === dir || dir === '' || f.dir.startsWith(`${dir}/`)).length;
  const errors: FolderError[] = [];
  const cancelled = () => hooks.cancelled?.() ?? false;

  let root: { id: string; name: string };
  try {
    root = target.mergeInto
      ? { id: target.mergeInto, name: tree.name }
      : await deps.createFolder(target.parentId, tree.name, 'rename');
  } catch (e) {
    return { rootName: tree.name, errors: [{ path: tree.name, code: codeOf(e), files: filesBelow('') }] };
  }
  hooks.onRoot?.({ id: root.id, name: root.name });

  const ids = new Map<string, string>([['', root.id]]);
  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  const levels = new Map<number, string[]>();
  for (const f of tree.folders) {
    const list = levels.get(depth(f)) ?? [];
    list.push(f);
    levels.set(depth(f), list);
  }
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    if (cancelled()) return { rootName: root.name, rootId: root.id, errors, cancelled: true };
    const todo = levels.get(level)!.filter((p) => ids.has(parentOf(p)));
    await mapLimit(todo, CONCURRENCY, async (p) => {
      try {
        ids.set(p, await ensureFolder(deps, ids.get(parentOf(p))!, baseOf(p)));
      } catch (e) {
        errors.push({ path: `${tree.name}/${p}`, code: codeOf(e), files: filesBelow(p) });
      }
    });
  }
  if (cancelled()) return { rootName: root.name, rootId: root.id, errors, cancelled: true };

  const byDir = new Map<string, File[]>();
  for (const { dir, file } of tree.files) {
    if (!ids.has(dir)) continue; // below a folder that could not be created
    const list = byDir.get(dir) ?? [];
    list.push(file);
    byDir.set(dir, list);
  }
  for (const [dir, files] of byDir) deps.enqueue(files, ids.get(dir)!);
  return { rootName: root.name, rootId: root.id, errors };
}
