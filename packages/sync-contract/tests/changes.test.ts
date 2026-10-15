import type { SyncItem } from '@synclet/shared';
import { describe, expect, it } from 'vitest';
import { contract, drainChanges, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();
const cursorNow = async (): Promise<string> => (await api.get('/sync/v1/cursor')).json().cursor;

/** Changes after `cursor` that concern `ids` (other activity of the same user may interleave). */
async function changesFor(cursor: string, ids: Set<string>) {
  const { changes, cursor: next } = await drainChanges(api, cursor);
  return { changes: changes.filter((c) => ids.has(c.op === 'upsert' ? c.item.id : c.id)), all: changes, cursor: next };
}

describe('cursor and changes', () => {
  it('an unchanged account yields no changes and keeps a usable cursor', async () => {
    const c = await cursorNow();
    const res = await api.get(`/sync/v1/changes?cursor=${c}`);
    expect(res.status).toBe(200);
    const page = res.json();
    expect(schemaErrors('ChangesPage', page)).toBe('');
    expect(page.hasMore).toBe(false);
    // Using the returned cursor again works (it is never ahead of the server).
    expect((await api.get(`/sync/v1/changes?cursor=${page.cursor}`)).status).toBe(200);
  });

  it('reports creates, renames and moves as upserts with the current state, coalesced per item', async () => {
    const box = await scratchFolder(api, ctx, 'changes');
    const c0 = await cursorNow();
    const a = await scratchFolder(api, ctx, 'target');
    const file = await uploadFile(api, box.id, 'one.txt', '1');
    await api.patch(`/sync/v1/items/${file.id}`, { name: 'two.txt' });
    await api.patch(`/sync/v1/items/${file.id}`, { name: 'three.txt', parentId: a.id });
    const { changes, all } = await changesFor(c0, new Set([a.id, file.id]));
    for (const ch of all) expect(schemaErrors('SyncChange', ch)).toBe('');
    // One entry per item, carrying the latest state.
    expect(changes.filter((ch) => ch.op === 'upsert' && ch.item.id === file.id)).toHaveLength(1);
    expect(changes).toContainEqual({ op: 'upsert', item: expect.objectContaining({ id: file.id, name: 'three.txt', parentId: a.id }) });
    expect(changes).toContainEqual({ op: 'upsert', item: expect.objectContaining({ id: a.id, parentId: ctx.folderId }) });
  });

  it('renaming a folder reports only the folder; children keep their ids', async () => {
    const box = await scratchFolder(api, ctx, 'rename-folder');
    const child = await uploadFile(api, box.id, 'child.txt', 'c');
    const c0 = await cursorNow();
    const res = await api.patch(`/sync/v1/items/${box.id}`, { name: `${box.name}-renamed` });
    expect(res.status).toBe(200);
    const { changes } = await changesFor(c0, new Set([box.id, child.id]));
    expect(changes).toEqual([{ op: 'upsert', item: expect.objectContaining({ id: box.id, name: `${box.name}-renamed` }) }]);
    expect((await api.get(`/sync/v1/items/${child.id}`)).json()).toMatchObject({ id: child.id, parentId: box.id });
  });

  it('deleting a folder reports a delete for the folder and every descendant', async () => {
    const box = await scratchFolder(api, ctx, 'delete-tree');
    const inner = (await api.mkdir(box.id, 'inner')).json<SyncItem>();
    const f1 = await uploadFile(api, box.id, 'x.txt', 'x');
    const f2 = await uploadFile(api, inner.id, 'y.txt', 'y');
    const c0 = await cursorNow();
    expect((await api.del(`/sync/v1/items/${box.id}`)).status).toBe(204);
    const ids = [box.id, inner.id, f1.id, f2.id];
    const { changes } = await changesFor(c0, new Set(ids));
    expect(changes).toHaveLength(4);
    expect(changes.every((ch) => ch.op === 'delete')).toBe(true);
    expect(changes.map((ch) => (ch as { id: string }).id).sort()).toEqual([...ids].sort());
  });

  it('an item created and deleted after the cursor is reported as a delete', async () => {
    const box = await scratchFolder(api, ctx, 'transient');
    const c0 = await cursorNow();
    const f = await uploadFile(api, box.id, 'tmp.txt', 't');
    await api.del(`/sync/v1/items/${f.id}`);
    const { changes } = await changesFor(c0, new Set([f.id]));
    expect(changes).toEqual([{ op: 'delete', id: f.id }]);
  });

  it('pages with limit and hasMore; following the cursors yields everything exactly once', async () => {
    const box = await scratchFolder(api, ctx, 'paging');
    const c0 = await cursorNow();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await uploadFile(api, box.id, `p${i}.txt`, String(i))).id);
    const first = (await api.get(`/sync/v1/changes?cursor=${c0}&limit=2`)).json();
    expect(first.changes).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const { changes } = await drainChanges(api, c0, 2);
    const fileIds = changes.filter((ch) => ch.op === 'upsert' && ids.includes(ch.item.id)).map((ch) => (ch as { item: SyncItem }).item.id);
    expect(fileIds.sort()).toEqual([...ids].sort());
  });

  it('a cursor ahead of the server is 410 cursor_expired; a malformed cursor is 400', async () => {
    const c = await cursorNow();
    const ahead = await api.get(`/sync/v1/changes?cursor=${BigInt(c) + 1_000_000n}`);
    expect(ahead.status).toBe(410);
    expect(ahead.json()).toMatchObject({ statusCode: 410, code: 'cursor_expired' });
    for (const bad of ['', 'abc', '-1']) {
      const res = await api.get(`/sync/v1/changes?cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.json().code).toBe('invalid_request');
    }
  });

  it('content replacement is an upsert with the new version', async () => {
    const box = await scratchFolder(api, ctx, 'content-change');
    const f = await uploadFile(api, box.id, 'v.txt', 'v1');
    const c0 = await cursorNow();
    expect((await api.replace(f.id, 'v2', '"v1"')).status).toBe(200);
    const { changes } = await changesFor(c0, new Set([f.id]));
    expect(changes).toEqual([{ op: 'upsert', item: expect.objectContaining({ id: f.id, version: 2, contentEtag: 'v2', size: 2 }) }]);
  });
});
