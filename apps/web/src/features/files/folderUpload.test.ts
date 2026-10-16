import type { SyncItem } from '@synclet/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  buildPlan, type FolderTree, type FolderUploadDeps, keepName, pickedFromDataTransfer, pickedFromEntries, pickedFromInputFiles, readAllEntries,
  resolveChoices, uploadTree,
} from './folderUpload';
import { isIgnored, nameKey } from './names';

// ---- fakes for the File and Directory Entries API -------------------------------------------------

type Entry = FileSystemFileEntry | FileSystemDirectoryEntry;
const BATCH = 100; // Chromium hands out at most 100 entries per readEntries call

function fileEntry(name: string, content = 'x'): FileSystemFileEntry {
  return {
    isFile: true, isDirectory: false, name, fullPath: '',
    file: (ok: (f: File) => void) => ok(new File([content], name)),
  } as unknown as FileSystemFileEntry;
}

function dirEntry(name: string, children: Entry[]): FileSystemDirectoryEntry & { reads: number } {
  const d = {
    isFile: false, isDirectory: true, name, fullPath: '', reads: 0,
    createReader() {
      let pos = 0;
      return {
        readEntries(ok: (e: Entry[]) => void) {
          d.reads++;
          const batch = children.slice(pos, pos + BATCH);
          pos += batch.length;
          setTimeout(() => ok(batch), 0);
        },
      };
    },
  };
  return d as unknown as FileSystemDirectoryEntry & { reads: number };
}

const item = (name: string, type: 'file' | 'folder' = 'folder', id = `${type === 'folder' ? 'd' : 'f'}_${name}`): SyncItem => ({
  id, parentId: 'root', type, kind: type, name, size: 0, mime: null, version: 1, sha256: null,
  etag: 'e', contentEtag: null, createdAt: '2026-10-15T10:00:00Z', modifiedAt: '2026-10-15T10:00:00Z', documentId: null,
  capabilities: { rename: true, move: true, delete: true, addChildren: type === 'folder' } as SyncItem['capabilities'],
});

// ---- names ------------------------------------------------------------------------------------------

describe('names', () => {
  it('mirrors the server ignore list', () => {
    for (const n of ['.DS_Store', '._foto.jpg', 'Thumbs.db', 'desktop.ini', '~$brief.docx', '.~lock.x.odt#', '.synclet-tmp-abc', '.synclet-trash-a-1', '$RECYCLE.BIN']) {
      expect(isIgnored(n), n).toBe(true);
    }
    expect(isIgnored('foto.jpg')).toBe(false);
  });
  it('compares names like the server (NFC, case-insensitive)', () => {
    expect(nameKey('\u00c4rger')).toBe(nameKey('A\u0308RGER'));
    expect(nameKey('URLAUB')).toBe(nameKey('urlaub'));
  });
});

// ---- traversal --------------------------------------------------------------------------------------

describe('tree traversal', () => {
  it('reads directories in batches until readEntries returns nothing', async () => {
    const many = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.txt`));
    const d = dirEntry('Viele', many);
    const entries = await readAllEntries(d.createReader());
    expect(entries).toHaveLength(250);
    expect(d.reads).toBe(4); // 100 + 100 + 50 + the empty batch that ends it
  });

  it('walks nested folders and keeps empty ones', async () => {
    const tree = dirEntry('Urlaub', [
      fileEntry('a.jpg'),
      dirEntry('Bilder', [fileEntry('b.jpg'), dirEntry('Leer', [])]),
      dirEntry('Riesig', Array.from({ length: 205 }, (_, i) => fileEntry(`r${i}.bin`))),
    ]);
    const picked = await pickedFromEntries([tree, fileEntry('lose.txt')]);
    const paths = picked.files.map((f) => f.path);
    expect(paths).toContain('Urlaub/a.jpg');
    expect(paths).toContain('Urlaub/Bilder/b.jpg');
    expect(paths).toContain('lose.txt');
    expect(paths.filter((p) => p.startsWith('Urlaub/Riesig/'))).toHaveLength(205);
    expect(picked.folders.sort()).toEqual(['Urlaub', 'Urlaub/Bilder', 'Urlaub/Bilder/Leer', 'Urlaub/Riesig']);
    expect(picked.files.find((f) => f.path === 'Urlaub/a.jpg')!.file.name).toBe('a.jpg');
  });

  it('takes the entries of a drop synchronously (they are gone after the event) and walks them', async () => {
    const entries = [dirEntry('Urlaub', [fileEntry('a.jpg')]), fileEntry('lose.txt')];
    let live = true;
    const dt = {
      items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => (live ? e : null), getAsFile: () => null })),
      files: [],
    } as unknown as DataTransfer;
    const pending = pickedFromDataTransfer(dt);
    live = false;
    const picked = await pending;
    expect(picked.files.map((f) => f.path).sort()).toEqual(['Urlaub/a.jpg', 'lose.txt']);
    expect(picked.folders).toEqual(['Urlaub']);
  });

  it('lists dropped folders without reading them when asked not to walk', async () => {
    const d = dirEntry('Urlaub', [fileEntry('a.jpg')]);
    const dt = { items: [d, fileEntry('lose.txt')].map((e) => ({ kind: 'file', webkitGetAsEntry: () => e, getAsFile: () => null })), files: [] } as unknown as DataTransfer;
    const picked = await pickedFromDataTransfer(dt, { walk: false });
    expect(picked.files.map((f) => f.path)).toEqual(['lose.txt']);
    expect(picked.folders).toEqual(['Urlaub']);
    expect(d.reads).toBe(0);
  });

  it('falls back to plain files without the entries API', async () => {
    const f = new File(['x'], 'a.txt');
    const picked = await pickedFromDataTransfer({ items: [], files: [f] } as unknown as DataTransfer);
    expect(picked).toEqual({ files: [{ path: 'a.txt', file: f }], folders: [] });
  });

  it('skips unreadable files and folders, counts them and keeps the rest in order', async () => {
    const broken = { ...fileEntry('kaputt.jpg'), file: (_ok: unknown, fail: (e: Error) => void) => fail(new Error('NotReadableError')) } as unknown as FileSystemFileEntry;
    const lockedDir = {
      isFile: false, isDirectory: true, name: 'Gesperrt', fullPath: '',
      createReader: () => ({ readEntries: (_ok: unknown, fail: (e: Error) => void) => fail(new Error('SecurityError')) }),
    } as unknown as FileSystemDirectoryEntry;
    const many = Array.from({ length: 20 }, (_, i) => fileEntry(`f${String(i).padStart(2, '0')}.txt`));
    const picked = await pickedFromEntries([dirEntry('Urlaub', [broken, lockedDir, ...many])]);
    expect(picked.unreadable).toBe(2);
    expect(picked.files.map((f) => f.path)).toEqual(many.map((e) => `Urlaub/${e.name}`));
    expect(picked.folders).toEqual(['Urlaub']);
  });

  it('uses webkitRelativePath of a folder selection', () => {
    const f = (rel: string) => {
      const file = new File(['x'], rel.split('/').pop()!);
      Object.defineProperty(file, 'webkitRelativePath', { value: rel });
      return file;
    };
    const picked = pickedFromInputFiles([f('Urlaub/a.jpg'), f('Urlaub/Bilder/b.jpg')]);
    expect(picked.files.map((x) => x.path)).toEqual(['Urlaub/a.jpg', 'Urlaub/Bilder/b.jpg']);
    expect(picked.folders.sort()).toEqual(['Urlaub', 'Urlaub/Bilder']);
  });
});

// ---- plan builder -----------------------------------------------------------------------------------

const pf = (path: string) => ({ path, file: new File(['x'], path.split('/').pop()!) });

describe('buildPlan', () => {
  it('splits loose files from folder trees and orders folders by depth', () => {
    const plan = buildPlan({
      files: [pf('lose.txt'), pf('Urlaub/a.jpg'), pf('Urlaub/Bilder/Tag 1/c.jpg'), pf('Urlaub/Bilder/b.jpg'), pf('Arbeit/x.pdf')],
      folders: ['Urlaub', 'Urlaub/Leer', 'Arbeit'],
    });
    expect(plan.looseFiles.map((f) => f.name)).toEqual(['lose.txt']);
    expect(plan.trees.map((t) => t.name)).toEqual(['Urlaub', 'Arbeit']);
    const urlaub = plan.trees[0];
    // Every ancestor exists, parents before children.
    expect(urlaub.folders).toEqual(['Bilder', 'Leer', 'Bilder/Tag 1']);
    expect(urlaub.files.map((f) => [f.dir, f.file.name])).toEqual([['', 'a.jpg'], ['Bilder/Tag 1', 'c.jpg'], ['Bilder', 'b.jpg']]);
    expect(plan.trees[1]).toMatchObject({ name: 'Arbeit', folders: [] });
  });

  it('skips system files and everything inside ignored folders', () => {
    const plan = buildPlan({
      files: [pf('Urlaub/.DS_Store'), pf('Urlaub/._a.jpg'), pf('Urlaub/a.jpg'), pf('Urlaub/Thumbs.db'), pf('Urlaub/~$doc.docx'),
        pf('Urlaub/.~lock.t.odt#'), pf('Urlaub/desktop.ini'), pf('Urlaub/$RECYCLE.BIN/x.txt'), pf('.DS_Store')],
      folders: ['Urlaub', 'Urlaub/$RECYCLE.BIN', '.Trashes'],
    });
    expect(plan.looseFiles).toEqual([]);
    expect(plan.trees).toHaveLength(1);
    expect(plan.trees[0].files.map((f) => f.file.name)).toEqual(['a.jpg']);
    expect(plan.trees[0].folders).toEqual([]);
    expect(plan.skipped).toBe(8);
  });
});

// ---- conflicts --------------------------------------------------------------------------------------

const tree = (name: string): FolderTree => ({ name, folders: [], files: [] });

describe('resolveChoices', () => {
  it('asks only for trees whose name exists (NFC, case-insensitive) and offers merge only for folders', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ choice: 'merge', applyAll: false })
      .mockResolvedValueOnce({ choice: 'rename', applyAll: false });
    const siblings = [item('urlaub'), item('Bericht', 'file'), item('Ärger')];
    const out = await resolveChoices([tree('Urlaub'), tree('Neu'), tree('bericht')], siblings, ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0][0]).toEqual({ name: 'Urlaub', existingType: 'folder', keepName: 'Urlaub (2)', remaining: 1 });
    expect(ask.mock.calls[1][0]).toMatchObject({ name: 'bericht', existingType: 'file', remaining: 0 });
    expect(out.map((o) => [o.tree.name, o.mergeInto ?? null])).toEqual([['Urlaub', 'd_urlaub'], ['Neu', null], ['bericht', null]]);
    // Merging keeps the existing folder's real name.
    expect(out[0].mergeName).toBe('urlaub');
    const nfd = await resolveChoices([tree('Ärger')], siblings, vi.fn().mockResolvedValue({ choice: 'merge', applyAll: false }));
    expect(nfd[0].mergeInto).toBe('d_Ärger');
  });

  it('drops cancelled trees and applies "for all" to the remaining conflicts', async () => {
    const siblings = [item('A'), item('B'), item('C', 'file'), item('D')];
    const ask = vi.fn().mockResolvedValueOnce({ choice: 'merge', applyAll: true }).mockResolvedValueOnce({ choice: 'cancel', applyAll: false });
    const out = await resolveChoices([tree('A'), tree('B'), tree('C'), tree('D'), tree('E')], siblings, ask);
    // A asked; B and D take "merge" from "for all"; C (a file) cannot be merged, so it is asked anyway.
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][0]).toMatchObject({ name: 'C', existingType: 'file' });
    expect(out.map((o) => [o.tree.name, o.mergeInto ?? null])).toEqual([['A', 'd_A'], ['B', 'd_B'], ['D', 'd_D'], ['E', null]]);
  });

  it('suggests the next free "(n)" name', () => {
    expect(keepName('Urlaub', [item('Urlaub'), item('urlaub (2)'), item('Urlaub (3)', 'file')])).toBe('Urlaub (4)');
  });
});

// ---- execution --------------------------------------------------------------------------------------

function fakeDeps(existing: Record<string, SyncItem[]> = {}) {
  let n = 0;
  const children = new Map<string, SyncItem[]>(Object.entries(existing));
  const created: { parentId: string; name: string; onConflict: string }[] = [];
  const enqueued: { names: string[]; parentId: string }[] = [];
  const deps: FolderUploadDeps = {
    createFolder: vi.fn(async (parentId: string, name: string, onConflict: 'fail' | 'rename') => {
      created.push({ parentId, name, onConflict });
      const sibs = children.get(parentId) ?? [];
      let final = name;
      const clash = sibs.find((s) => nameKey(s.name) === nameKey(name));
      if (clash) {
        if (onConflict === 'fail') throw new ApiError(409, 'name_conflict', 'exists', clash);
        let i = 2;
        while (sibs.some((s) => nameKey(s.name) === nameKey(`${name} (${i})`))) i++;
        final = `${name} (${i})`;
      }
      const it = { ...item(final, 'folder', `d_${++n}`), parentId };
      children.set(parentId, [...sibs, it]);
      return it;
    }),
    listChildren: vi.fn(async (id: string) => children.get(id) ?? []),
    enqueue: vi.fn((files: File[], parentId: string) => { enqueued.push({ names: files.map((f) => f.name), parentId }); }),
  };
  return { deps, created, enqueued };
}

describe('uploadTree', () => {
  const urlaub = (): FolderTree => buildPlan({
    files: [pf('Urlaub/a.jpg'), pf('Urlaub/Bilder/b.jpg'), pf('Urlaub/Bilder/c.jpg'), pf('Urlaub/Bilder/Tag/d.jpg')],
    folders: ['Urlaub', 'Urlaub/Leer'],
  }).trees[0];

  it('keeps both: creates the top folder with rename, then subfolders level by level, then enqueues the files', async () => {
    const { deps, created, enqueued } = fakeDeps({ root: [item('Urlaub', 'folder', 'd_old')] });
    const out = await uploadTree(urlaub(), { parentId: 'root' }, deps);
    expect(out).toMatchObject({ rootName: 'Urlaub (2)', errors: [] });
    expect(created[0]).toEqual({ parentId: 'root', name: 'Urlaub', onConflict: 'rename' });
    expect(created.slice(1).map((c) => c.name)).toEqual(['Bilder', 'Leer', 'Tag']);
    const top = (await deps.listChildren('root')).find((i) => i.name === 'Urlaub (2)')!.id;
    const bilder = (await deps.listChildren(top)).find((i) => i.name === 'Bilder')!.id;
    expect(created.find((c) => c.name === 'Tag')!.parentId).toBe(bilder);
    expect(enqueued).toEqual(expect.arrayContaining([
      { names: ['a.jpg'], parentId: top },
      { names: ['b.jpg', 'c.jpg'], parentId: bilder },
    ]));
    expect(enqueued.flatMap((e) => e.names)).toHaveLength(4);
  });

  it('merges: reuses the existing top folder and same-named subfolders (409 with a folder item)', async () => {
    const { deps, created, enqueued } = fakeDeps({ root: [item('Urlaub', 'folder', 'd_old')], d_old: [item('bilder', 'folder', 'd_oldB'), item('Leer', 'file', 'f_leer')] });
    const out = await uploadTree(urlaub(), { parentId: 'root', mergeInto: 'd_old' }, deps);
    expect(out.rootName).toBe('Urlaub');
    expect(created.some((c) => c.parentId === 'root')).toBe(false);
    expect(created.find((c) => c.name === 'Bilder')).toMatchObject({ parentId: 'd_old', onConflict: 'fail' });
    // "Leer" exists as a FILE in the target: the folder is created next to it as "Leer (2)".
    expect(created.filter((c) => c.name === 'Leer').map((c) => c.onConflict)).toEqual(['fail', 'rename']);
    expect(created.find((c) => c.name === 'Tag')!.parentId).toBe('d_oldB');
    expect(enqueued).toEqual(expect.arrayContaining([
      { names: ['a.jpg'], parentId: 'd_old' },
      { names: ['b.jpg', 'c.jpg'], parentId: 'd_oldB' },
    ]));
  });

  it('a merge reports the existing folder\'s real name', async () => {
    const { deps } = fakeDeps({ d_old: [] });
    const onRoot = vi.fn();
    const out = await uploadTree(urlaub(), { parentId: 'root', mergeInto: 'd_old', mergeName: 'URLAUB' }, deps, { onRoot });
    expect(out.rootName).toBe('URLAUB');
    expect(onRoot).toHaveBeenCalledWith({ id: 'd_old', name: 'URLAUB' });
  });

  it('a 409 without an item looks the folder up by name', async () => {
    const { deps } = fakeDeps({ d_old: [item('BILDER', 'folder', 'd_B')] });
    (deps.createFolder as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { throw new ApiError(409, 'name_conflict', 'exists on disk'); });
    const t: FolderTree = { name: 'Urlaub', folders: ['Bilder'], files: [{ dir: 'Bilder', file: new File(['x'], 'b.jpg') }] };
    const out = await uploadTree(t, { parentId: 'root', mergeInto: 'd_old' }, deps);
    expect(out.errors).toEqual([]);
    expect(deps.enqueue).toHaveBeenCalledWith([expect.objectContaining({ name: 'b.jpg' })], 'd_B');
  });

  it('reports a failed folder, skips its subtree and uploads the rest', async () => {
    const { deps, enqueued } = fakeDeps();
    const create = deps.createFolder as ReturnType<typeof vi.fn>;
    const real = create.getMockImplementation()! as (p: string, n: string, c: 'fail' | 'rename') => Promise<SyncItem>;
    create.mockImplementation(async (p: string, name: string, c: 'fail' | 'rename') => {
      if (name === 'Bilder') throw new ApiError(400, 'invalid_name', 'bad');
      return real(p, name, c);
    });
    const out = await uploadTree(urlaub(), { parentId: 'root' }, deps);
    expect(out.errors).toEqual([{ path: 'Urlaub/Bilder', code: 'invalid_name', files: 3 }]);
    expect(create.mock.calls.map((c) => c[1])).not.toContain('Tag');
    expect(enqueued.flatMap((e) => e.names)).toEqual(['a.jpg']);
  });

  it('fails as a whole when the top folder cannot be created', async () => {
    const { deps } = fakeDeps();
    (deps.createFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(403, 'forbidden', 'no'));
    const out = await uploadTree(urlaub(), { parentId: 'root' }, deps);
    expect(out.errors).toEqual([{ path: 'Urlaub', code: 'forbidden', files: 4 }]);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('reports the real top folder name as soon as it exists and stops when cancelled', async () => {
    const { deps } = fakeDeps({ root: [item('Urlaub')] });
    const onRoot = vi.fn();
    const out = await uploadTree(urlaub(), { parentId: 'root' }, deps, { onRoot, cancelled: () => true });
    expect(onRoot).toHaveBeenCalledWith(expect.objectContaining({ name: 'Urlaub (2)' }));
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(out.cancelled).toBe(true);
  });
});
