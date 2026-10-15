import type { SyncItem } from '@synclet/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();
const MISSING_FOLDER = 'd_00000000-0000-4000-8000-000000000000';
const MISSING_FILE = 'f_00000000-0000-4000-8000-000000000000';

describe('items', () => {
  it('root: kind root, parentId null, name = username, fixed capabilities', async () => {
    const res = await api.get('/sync/v1/items/root');
    expect(res.status).toBe(200);
    const root = res.json<SyncItem>();
    expect(schemaErrors('SyncItem', root)).toBe('');
    const account = (await api.get('/sync/v1/account')).json();
    expect(root).toMatchObject({
      id: 'root', parentId: null, type: 'folder', kind: 'root', name: account.slug, size: 0, version: null, contentEtag: null, documentId: null,
      capabilities: { read: true, write: true, rename: false, move: false, delete: false, addChildren: true },
    });
    expect(root.preview).toBeUndefined();
  });

  it('folders and files: ids, parent ids, etags and capabilities', async () => {
    const folder = (await api.get(`/sync/v1/items/${ctx.folderId}`)).json<SyncItem>();
    expect(schemaErrors('SyncItem', folder)).toBe('');
    expect(folder).toMatchObject({
      id: ctx.folderId, parentId: 'root', type: 'folder', kind: 'folder', name: ctx.folderName, size: 0, mime: null, version: null,
      sha256: null, contentEtag: null, documentId: null,
      capabilities: { read: true, write: true, rename: true, move: true, delete: true, addChildren: true },
    });
    expect(folder.id).toMatch(/^d_[0-9a-f-]{36}$/);
    expect(folder.etag).toMatch(/^t/);

    const sub = await scratchFolder(api, ctx, 'items');
    expect(sub.parentId).toBe(ctx.folderId);
    const file = await uploadFile(api, sub.id, 'hello.txt', 'hello');
    expect(schemaErrors('SyncItem', file)).toBe('');
    expect(file).toMatchObject({
      parentId: sub.id, type: 'file', kind: 'file', name: 'hello.txt', size: 5, mime: 'text/plain', version: 1,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', etag: 'v1', contentEtag: 'v1', documentId: file.id,
      capabilities: { read: true, write: true, rename: true, move: true, delete: true, addChildren: false },
      preview: { kind: 'text' },
    });
    expect(file.id).toMatch(/^f_[0-9a-f-]{36}$/);
    expect((await api.get(`/sync/v1/items/${file.id}`)).json()).toEqual(file);
  });

  it('malformed ids are 400 invalid_request; unknown ids are 404 not_found', async () => {
    for (const id of ['nope', 'x_00000000-0000-4000-8000-000000000000', 'd_123']) {
      const res = await api.get(`/sync/v1/items/${id}`);
      expect(res.status).toBe(400);
      expect(res.json().code).toBe('invalid_request');
    }
    for (const id of [MISSING_FOLDER, MISSING_FILE]) {
      const res = await api.get(`/sync/v1/items/${id}`);
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ statusCode: 404, code: 'not_found' });
    }
  });

  it('a file id with a d_ prefix (or vice versa) is not found', async () => {
    const sub = await scratchFolder(api, ctx, 'prefix');
    const file = await uploadFile(api, sub.id, 'a.txt', 'a');
    expect((await api.get(`/sync/v1/items/d_${file.id.slice(2)}`)).status).toBe(404);
    expect((await api.get(`/sync/v1/items/f_${sub.id.slice(2)}`)).status).toBe(404);
  });
});

describe('children', () => {
  let parent: SyncItem;
  const folders: SyncItem[] = [];
  const files: SyncItem[] = [];

  beforeAll(async () => {
    parent = await scratchFolder(api, ctx, 'children');
    for (const n of ['f1', 'f2', 'f3']) folders.push((await api.mkdir(parent.id, n)).json());
    for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) files.push(await uploadFile(api, parent.id, n, n));
  });

  it('lists folders first, then files, each group ordered by id, with keyset paging', async () => {
    const expected = [
      ...folders.map((f) => f.id).sort(),
      ...files.map((f) => f.id).sort(),
    ];
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const q = new URLSearchParams({ limit: '2', ...(token ? { pageToken: token } : {}) });
      const res = await api.get(`/sync/v1/items/${parent.id}/children?${q}`);
      expect(res.status).toBe(200);
      const page = res.json();
      expect(schemaErrors('ChildrenPage', page)).toBe('');
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i: SyncItem) => i.id));
      token = page.nextPageToken;
      pages++;
    } while (token && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(4); // 2 + 2 + 2 + 1, the last page has nextPageToken null
  });

  it('a full page has nextPageToken null', async () => {
    const page = (await api.get(`/sync/v1/items/${parent.id}/children?limit=100`)).json();
    expect(page.items).toHaveLength(7);
    expect(page.nextPageToken).toBeNull();
  });

  it('cursor is the state before the first page: changes from it include later edits', async () => {
    const page = (await api.get(`/sync/v1/items/${parent.id}/children`)).json();
    const renamed = (await api.patch(`/sync/v1/items/${files[0].id}`, { name: 'a-renamed.txt' })).json<SyncItem>();
    const changes = (await api.get(`/sync/v1/changes?cursor=${page.cursor}`)).json();
    expect(changes.changes).toContainEqual({ op: 'upsert', item: expect.objectContaining({ id: renamed.id, name: 'a-renamed.txt' }) });
  });

  it('root children include the suite folder', async () => {
    const ids: string[] = [];
    let token: string | null = null;
    do {
      const page: { items: SyncItem[]; nextPageToken: string | null } = (await api.get(`/sync/v1/items/root/children?limit=1000${token ? `&pageToken=${token}` : ''}`)).json();
      ids.push(...page.items.map((i: SyncItem) => i.id));
      token = page.nextPageToken;
    } while (token);
    expect(ids).toContain(ctx.folderId);
  });

  it('children of a file and malformed page tokens are 400 invalid_request', async () => {
    const res = await api.get(`/sync/v1/items/${files[1].id}/children`);
    expect(res.status).toBe(400);
    expect(res.json().code).toBe('invalid_request');
    for (const token of ['garbage', '2:00000000-0000-4000-8000-000000000000', '0:nope']) {
      const bad = await api.get(`/sync/v1/items/${parent.id}/children?pageToken=${encodeURIComponent(token)}`);
      expect(bad.status).toBe(400);
      expect(bad.json().code).toBe('invalid_request');
    }
  });

  it('children of an unknown folder are 404', async () => {
    expect((await api.get(`/sync/v1/items/${MISSING_FOLDER}/children`)).status).toBe(404);
  });
});
