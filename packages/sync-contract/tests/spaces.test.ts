import type { SyncAccount, SyncItem } from '@synclet/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomSuffix } from '../src/client.js';
import { contract, drainChanges, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();
const account = async (): Promise<SyncAccount> => (await api.get('/sync/v1/account')).json<SyncAccount>();

describe('spaces', () => {
  it('/account lists the personal space first, in the documented shape', async () => {
    const acc = await account();
    expect(schemaErrors('SyncAccount', acc)).toBe('');
    expect(acc.spaces[0]).toMatchObject({ id: 'personal', kind: 'personal', rootId: 'root', canWrite: true });
    for (const s of acc.spaces.slice(1)) {
      expect(['shared', 'external']).toContain(s.kind);
      expect(s.rootId).toBe(`r_${s.id}`);
      if (s.status === 'missing') expect(s.canWrite).toBe(false);
    }
    // Order: personal, then team folders (shared), then external storages.
    const rank = { personal: 0, shared: 1, external: 2 } as const;
    const ranks = acc.spaces.map((s) => rank[s.kind]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('?space=personal is the default for cursor and changes (device token)', async () => {
    const c = (await api.get('/sync/v1/cursor')).json().cursor;
    const res = await api.get('/sync/v1/cursor?space=personal');
    expect(res.status).toBe(200);
    expect(schemaErrors('CursorResponse', res.json())).toBe('');
    const box = await scratchFolder(api, ctx, 'space-default');
    const file = await uploadFile(api, box.id, 'p.txt', 'p');
    expect(file.spaceId).toBe('personal');
    const { changes } = await drainChanges(api, c, 500, 'personal');
    expect(changes).toContainEqual({ op: 'upsert', item: expect.objectContaining({ id: file.id, spaceId: 'personal' }) });
    // The same cursor without ?space= sees the same feed.
    const plain = await drainChanges(api, c);
    expect(plain.changes.map((ch) => (ch.op === 'upsert' ? ch.item.id : ch.id))).toEqual(changes.map((ch) => (ch.op === 'upsert' ? ch.item.id : ch.id)));
  });

  it('an unknown or malformed space → 404 not_found; an unknown space root → 404', async () => {
    for (const space of [randomUUID(), 'nope']) {
      for (const url of [`/sync/v1/cursor?space=${space}`, `/sync/v1/changes?cursor=0&space=${space}`]) {
        const res = await api.get(url);
        expect(res.status).toBe(404);
        expect(schemaErrors('Error', res.json())).toBe('');
        expect(res.json().code).toBe('not_found');
      }
    }
    const root = await api.get(`/sync/v1/items/r_${randomUUID()}`);
    expect(root.status).toBe(404);
    expect(root.json().code).toBe('not_found');
  });

  /**
   * A team folder of its own, created through the admin API when the suite's web token belongs to
   * an administrator (skipped otherwise, or when the server has no teams folder). Removed again at
   * the end: the server drops it from Synclet and keeps the (then empty) folder on disk.
   */
  describe('team folder', () => {
    let team: { id: string; name: string } | null = null;
    let skipReason = '';
    let me = '';
    const admin = ctx.webToken ? api.withToken(ctx.webToken) : null;
    const setMembers = (role: 'read' | 'write' | null) =>
      admin!.patch(`/admin/spaces/${team!.id}`, { members: role ? [{ kind: 'user', id: me, role }] : [] });

    beforeAll(async () => {
      me = (await account()).userId;
      if (!admin) { skipReason = 'no web access token (SYNCLET_TOKEN is a device token)'; return; }
      const res = await admin.post('/admin/spaces', { name: `contract-team-${randomSuffix()}`, members: [{ kind: 'user', id: me, role: 'write' }] });
      if (res.status === 403) { skipReason = 'the suite user is not an administrator'; return; }
      if (res.status === 503) { skipReason = 'the server has no teams folder'; return; }
      if (res.status !== 201) throw new Error(`POST /admin/spaces: ${res.status} ${res.text()}`);
      team = res.json();
    });
    afterAll(async () => {
      if (!team || !admin) return;
      await setMembers('write');
      // Empty the team folder through the API (its trash goes with the space), then remove the space.
      const children = (await api.get(`/sync/v1/items/r_${team.id}/children`)).json<{ items: SyncItem[] }>().items ?? [];
      for (const c of children) await api.del(`/sync/v1/items/${c.id}`);
      const del = await admin.del(`/admin/spaces/${team.id}`);
      if (del.status !== 204) throw new Error(`DELETE /admin/spaces: ${del.status} ${del.text()}`);
    });

    it('is listed with rootId r_<uuid>; its root, cursor and changes work with a device token', async (t) => {
      if (!team) return t.skip(skipReason);
      const acc = await account();
      expect(schemaErrors('SyncAccount', acc)).toBe('');
      expect(acc.spaces).toContainEqual({ id: team.id, kind: 'shared', name: team.name, rootId: `r_${team.id}`, canWrite: true, status: 'available' });

      const root = await api.get(`/sync/v1/items/r_${team.id}`);
      expect(root.status).toBe(200);
      expect(schemaErrors('SyncItem', root.json())).toBe('');
      expect(root.json()).toMatchObject({ id: `r_${team.id}`, parentId: null, kind: 'root', name: team.name, spaceId: team.id,
        capabilities: { addChildren: true, rename: false, move: false, delete: false } });

      const c0 = (await api.get(`/sync/v1/cursor?space=${team.id}`)).json().cursor;
      const personalBefore = (await api.get('/sync/v1/cursor')).json().cursor;
      const folder = (await api.mkdir(`r_${team.id}`, 'docs')).json<SyncItem>();
      expect(folder).toMatchObject({ parentId: `r_${team.id}`, spaceId: team.id });
      const file = await uploadFile(api, folder.id, 'a.txt', 'team');
      const { changes, cursor } = await drainChanges(api, c0, 500, team.id);
      for (const ch of changes) expect(schemaErrors('SyncChange', ch)).toBe('');
      expect(changes.map((ch) => ch.op === 'upsert' && ch.item.id)).toEqual(expect.arrayContaining([folder.id, file.id]));
      // Team changes never show up in the personal feed.
      const personal = await drainChanges(api, personalBefore);
      expect(personal.changes.filter((ch) => [folder.id, file.id].includes(ch.op === 'upsert' ? ch.item.id : ch.id))).toEqual([]);
      expect((await api.get(`/sync/v1/changes?space=${team.id}&cursor=${cursor}`)).json()).toMatchObject({ changes: [], hasMore: false });
      // children carries the cursor of the folder's space.
      const page = (await api.get(`/sync/v1/items/${folder.id}/children`)).json();
      expect(page.cursor).toBe((await api.get(`/sync/v1/cursor?space=${team.id}`)).json().cursor);
    });

    it('moving between spaces keeps the id: delete in the old space, upsert in the new one', async (t) => {
      if (!team) return t.skip(skipReason);
      const box = await scratchFolder(api, ctx, 'cross-space');
      const file = await uploadFile(api, box.id, 'move.txt', 'm');
      const cp = (await api.get('/sync/v1/cursor')).json().cursor;
      const ct = (await api.get(`/sync/v1/cursor?space=${team.id}`)).json().cursor;
      const moved = await api.patch(`/sync/v1/items/${file.id}`, { parentId: `r_${team.id}` });
      expect(moved.status).toBe(200);
      expect(moved.json()).toMatchObject({ id: file.id, parentId: `r_${team.id}`, spaceId: team.id });
      expect((await drainChanges(api, cp)).changes).toContainEqual({ op: 'delete', id: file.id });
      expect((await drainChanges(api, ct, 500, team.id)).changes).toContainEqual({ op: 'upsert', item: expect.objectContaining({ id: file.id, spaceId: team.id }) });
      // And back (the suite folder's teardown cleans it up).
      expect((await api.patch(`/sync/v1/items/${file.id}`, { parentId: box.id })).json()).toMatchObject({ id: file.id, spaceId: 'personal' });
    });

    it('read access: listed with canWrite false, writes → 403', async (t) => {
      if (!team) return t.skip(skipReason);
      expect((await setMembers('read')).status).toBe(200);
      try {
        expect((await account()).spaces.find((s) => s.id === team!.id)).toMatchObject({ canWrite: false });
        expect((await api.get(`/sync/v1/items/r_${team.id}`)).json().capabilities).toMatchObject({ write: false, addChildren: false });
        const res = await api.mkdir(`r_${team.id}`, 'nope');
        expect(res.status).toBe(403);
        expect(res.json().code).toBe('forbidden');
      } finally {
        await setMembers('write');
      }
    });

    it('a non-member gets 404 on the team root, its cursor and changes, and no longer sees it', async (t) => {
      if (!team) return t.skip(skipReason);
      expect((await setMembers(null)).status).toBe(200);
      try {
        expect((await account()).spaces.map((s) => s.id)).not.toContain(team.id);
        for (const url of [`/sync/v1/items/r_${team.id}`, `/sync/v1/items/r_${team.id}/children`, `/sync/v1/cursor?space=${team.id}`, `/sync/v1/changes?cursor=0&space=${team.id}`]) {
          const res = await api.get(url);
          expect(res.status).toBe(404);
          expect(res.json().code).toBe('not_found');
        }
      } finally {
        await setMembers('write');
      }
    });
  });
});
