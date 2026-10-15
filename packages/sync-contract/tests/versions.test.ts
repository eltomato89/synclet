import type { ServerCapabilities, SyncItem } from '@synclet/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { arrayErrors, schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

/** GET /capabilities; a server without the route (404) has versions and office disabled. */
async function capabilities(): Promise<ServerCapabilities | null> {
  const res = await api.get('/sync/v1/capabilities');
  if (res.status === 404) return null;
  expect(res.status).toBe(200);
  return res.json();
}

describe('capabilities', () => {
  it('reports optional features (or 404 on servers before Phase 1c)', async () => {
    const res = await api.get('/sync/v1/capabilities');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(schemaErrors('ServerCapabilities', res.json())).toBe('');
  });
});

describe('versions', () => {
  let caps: ServerCapabilities | null;
  let box: SyncItem;
  beforeAll(async () => {
    caps = await capabilities();
    box = await scratchFolder(api, ctx, 'versions');
  });

  it('disabled: version routes are 404 not_found', async (t) => {
    if (caps?.versions) t.skip('versions are enabled on this server');
    const f = await uploadFile(api, box.id, 'off.txt', 'one');
    await api.replace(f.id, 'two', '"v1"');
    const res = await api.get(`/sync/v1/items/${f.id}/versions`);
    expect(res.status).toBe(404);
    if (caps) expect(res.json()).toMatchObject({ code: 'not_found', message: 'versions disabled' });
  });

  it('enabled: replacing keeps the previous content as a version; list, download, restore', async (t) => {
    if (!caps?.versions) t.skip(caps ? 'versions disabled (capabilities.versions = false)' : 'no /capabilities route: versions disabled');
    const f = await uploadFile(api, box.id, 'doc.txt', 'first');
    const v2 = (await api.replace(f.id, 'second!', '"v1"')).json<SyncItem>();
    const v3 = (await api.replace(f.id, 'third', `"${v2.contentEtag}"`)).json<SyncItem>();
    expect(v3.version).toBe(3);

    const res = await api.get(`/sync/v1/items/${f.id}/versions`);
    expect(res.status).toBe(200);
    const versions = res.json();
    expect(arrayErrors('Version', versions)).toBe('');
    // Newest first: the content of version 2, then version 1.
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ size: 7, source: 'api', sha256: v2.sha256 });
    expect(versions[1]).toMatchObject({ size: 5, sha256: f.sha256 });

    const dl = await api.get(`/sync/v1/items/${f.id}/versions/${versions[1].id}/content`);
    expect(dl.status).toBe(200);
    expect(dl.text()).toBe('first');
    expect(dl.headers.get('etag')).toBe('"v1"');
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="doc \(v1\)\.txt"/);
    // The item's download token also opens its version content.
    const dt = (await api.post(`/sync/v1/items/${f.id}/download-token`)).json();
    expect((await api.get(`/sync/v1/items/${f.id}/versions/${versions[1].id}/content?dt=${encodeURIComponent(dt.token)}`, { token: null })).status).toBe(200);

    const restored = await api.post(`/sync/v1/items/${f.id}/versions/${versions[1].id}/restore`);
    expect(restored.status).toBe(200);
    expect(schemaErrors('SyncItem', restored.json())).toBe('');
    expect(restored.json()).toMatchObject({ id: f.id, version: 4, contentEtag: 'v4', size: 5, sha256: f.sha256 });
    expect((await api.get(`/sync/v1/items/${f.id}/content`)).text()).toBe('first');
    const after = (await api.get(`/sync/v1/items/${f.id}/versions`)).json();
    // The content that was current before the restore (v3) is now a version too.
    expect(after[0]).toMatchObject({ version: 3, source: 'restore', size: 5 });
  });

  it('enabled: folders are 400, unknown versions 404', async (t) => {
    if (!caps?.versions) t.skip('versions disabled');
    const f = await uploadFile(api, box.id, 'x.txt', 'x');
    expect((await api.get(`/sync/v1/items/${box.id}/versions`)).status).toBe(400);
    expect((await api.get(`/sync/v1/items/${f.id}/versions/00000000-0000-4000-8000-000000000000/content`)).status).toBe(404);
    expect((await api.post(`/sync/v1/items/${f.id}/versions/00000000-0000-4000-8000-000000000000/restore`)).status).toBe(404);
  });
});
