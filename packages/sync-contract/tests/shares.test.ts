import type { SyncItem } from '@synclet/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { arrayErrors, schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

const DAY = 24 * 3600 * 1000;

describe('share links (/api/shares) with a device token', () => {
  let box: SyncItem;
  beforeAll(async () => { box = await scratchFolder(api, ctx, 'shares'); });

  it('create, list, patch, rotate, revoke', async () => {
    const expiresAt = new Date(Date.now() + DAY).toISOString();
    const created = await api.post('/shares', { itemId: box.id, password: 'secret-pw', expiresAt, allowUpload: true });
    expect(created.status).toBe(201);
    const share = created.json();
    expect(schemaErrors('ShareLink', share)).toBe('');
    expect(share).toMatchObject({
      itemId: box.id, itemName: box.name, itemType: 'folder', hasPassword: true,
      allowDownload: true, allowUpload: true, revokedAt: null, hits: 0, itemTrashed: false,
    });
    expect(new Date(share.expiresAt).getTime()).toBe(new Date(expiresAt).getTime());
    expect(share.url).toMatch(/\/s\/[A-Za-z0-9_-]+$/);

    const list = await api.get(`/shares?itemId=${box.id}`);
    expect(list.status).toBe(200);
    expect(arrayErrors('ShareLink', list.json())).toBe('');
    expect(list.json().map((s: { id: string }) => s.id)).toContain(share.id);

    const patched = await api.patch(`/shares/${share.id}`, { password: null });
    expect(patched.status).toBe(200);
    expect(schemaErrors('ShareLink', patched.json())).toBe('');
    expect(patched.json()).toMatchObject({ id: share.id, hasPassword: false });

    const rotated = await api.post(`/shares/${share.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(schemaErrors('ShareLink', rotated.json())).toBe('');
    expect(rotated.json().id).toBe(share.id);
    expect(rotated.json().url).not.toBe(share.url);

    // Revoking is idempotent; revoked shares disappear from the list.
    expect((await api.del(`/shares/${share.id}`)).status).toBe(204);
    expect((await api.del(`/shares/${share.id}`)).status).toBe(204);
    const after = (await api.get(`/shares?itemId=${box.id}`)).json();
    expect(after.map((s: { id: string }) => s.id)).not.toContain(share.id);
    // A revoked share can no longer be changed.
    expect((await api.patch(`/shares/${share.id}`, { allowDownload: false })).status).toBe(404);
  });

  it('a file share without options uses the defaults; allowUpload on a file is 400 invalid_request', async () => {
    const f = await uploadFile(api, box.id, 'shared.txt', 'x');
    const res = await api.post('/shares', { itemId: f.id });
    expect(res.status).toBe(201);
    expect(schemaErrors('ShareLink', res.json())).toBe('');
    expect(res.json()).toMatchObject({ itemType: 'file', hasPassword: false, expiresAt: null, allowDownload: true, allowUpload: false });

    const bad = await api.post('/shares', { itemId: f.id, allowUpload: true });
    expect(bad.status).toBe(400);
    expect(schemaErrors('Error', bad.json())).toBe('');
    expect(bad.json().code).toBe('invalid_request');
    const badPatch = await api.patch(`/shares/${res.json().id}`, { allowUpload: true });
    expect(badPatch.status).toBe(400);
    expect(badPatch.json().code).toBe('invalid_request');
  });

  it('errors: unknown id 404 not_found; past expiresAt 400 invalid_request; unknown item 404', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    for (const res of [
      await api.patch(`/shares/${unknown}`, { allowDownload: false }),
      await api.post(`/shares/${unknown}/rotate`),
      await api.del(`/shares/${unknown}`),
    ]) {
      expect(res.status).toBe(404);
      expect(schemaErrors('Error', res.json())).toBe('');
      expect(res.json().code).toBe('not_found');
    }

    const past = await api.post('/shares', { itemId: box.id, expiresAt: new Date(Date.now() - DAY).toISOString() });
    expect(past.status).toBe(400);
    expect(schemaErrors('Error', past.json())).toBe('');
    expect(past.json().code).toBe('invalid_request');

    const noItem = await api.post('/shares', { itemId: 'f_00000000-0000-4000-8000-000000000000' });
    expect(noItem.status).toBe(404);
    expect(noItem.json().code).toBe('not_found');
  });
});
