import type { SyncItem } from '@synclet/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { arrayErrors, schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

async function restore(id: string) {
  let res = await api.post(`/trash/${id}/restore`);
  for (let i = 0; i < 20 && res.status === 409; i++) {
    await new Promise((r) => setTimeout(r, 250));
    res = await api.post(`/trash/${id}/restore`);
  }
  return res;
}

const trashEntryOf = async (itemId: string) =>
  (await api.get('/trash')).json<{ id: string; itemId: string }[]>().find((e) => e.itemId === itemId);

describe('trash with a device token', () => {
  let box: SyncItem;
  beforeAll(async () => { box = await scratchFolder(api, ctx, 'trash'); });

  it('delete, list, restore (renamed:false), restore after a name clash (renamed:true), delete forever', async () => {
    const f = await uploadFile(api, box.id, 'doc.txt', 'one');
    expect((await api.del(`/sync/v1/items/${f.id}`)).status).toBe(204);
    const listed = (await api.get('/trash')).json();
    expect(arrayErrors('TrashEntry', listed)).toBe('');
    const entry = listed.find((e: { itemId: string }) => e.itemId === f.id);
    expect(entry).toMatchObject({ type: 'file', name: 'doc.txt' });

    const ok = await restore(entry.id);
    expect(ok.status).toBe(200);
    expect(schemaErrors('RestoreResult', ok.json())).toBe('');
    expect(ok.json()).toMatchObject({ renamed: false, item: { id: f.id, name: 'doc.txt', parentId: box.id } });
    expect(typeof ok.json().restoredTo).toBe('string');

    // Delete again, occupy the name, restore → renamed.
    expect((await api.del(`/sync/v1/items/${f.id}`)).status).toBe(204);
    const entry2 = await trashEntryOf(f.id);
    expect(entry2).toBeDefined();
    await uploadFile(api, box.id, 'doc.txt', 'two');
    const renamed = await restore(entry2!.id);
    expect(renamed.status).toBe(200);
    expect(schemaErrors('RestoreResult', renamed.json())).toBe('');
    expect(renamed.json().renamed).toBe(true);
    expect(renamed.json().item.name).not.toBe('doc.txt');

    // Delete forever.
    expect((await api.del(`/sync/v1/items/${f.id}`)).status).toBe(204);
    const entry3 = await trashEntryOf(f.id);
    expect((await api.del(`/trash/${entry3!.id}`)).status).toBe(204);
    expect(await trashEntryOf(f.id)).toBeUndefined();
    const gone = await api.del(`/trash/${entry3!.id}`);
    expect(gone.status).toBe(404);
    expect(gone.json().code).toBe('not_found');
  });

  it('DELETE /trash empties the trash and reports {removed}', async () => {
    // Only the entry of this test is removed from the user's perspective: it must be counted.
    const f = await uploadFile(api, box.id, 'empty-me.txt', 'x');
    expect((await api.del(`/sync/v1/items/${f.id}`)).status).toBe(204);
    const res = await api.del('/trash');
    expect(res.status).toBe(200);
    expect(schemaErrors('EmptyTrashResponse', res.json())).toBe('');
    expect(res.json().removed).toBeGreaterThanOrEqual(1);
    expect(await trashEntryOf(f.id)).toBeUndefined();
  });
});

describe('search and recent with a device token', () => {
  it('finds extracted text and lists the file as recent', async () => {
    const box = await scratchFolder(api, ctx, 'search');
    const f = await uploadFile(api, box.id, 'hello.txt', 'a juicy kumquat on the table');
    const recent = await api.get('/sync/v1/recent?limit=50');
    expect(recent.status).toBe(200);
    expect(arrayErrors('SyncItem', recent.json())).toBe('');
    expect(recent.json().map((i: SyncItem) => i.id)).toContain(f.id);

    // Text extraction is asynchronous.
    let hit: { item: SyncItem } | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await api.get('/sync/v1/search?q=kumquat');
      expect(res.status).toBe(200);
      expect(schemaErrors('SearchResponse', res.json())).toBe('');
      hit = res.json().hits.find((h: { item: SyncItem }) => h.item.id === f.id);
      if (hit) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(hit, 'search did not find "kumquat" within 30 s (is the worker running?)').toBeDefined();
  }, 40_000);
});
