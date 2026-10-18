import { describe, expect, it } from 'vitest';
import { contract, scratchFolder, uploadFile } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

async function waitDone(id: string) {
  for (let i = 0; i < 100; i++) {
    const op = (await api.get(`/sync/v1/operations/${id}`)).json();
    if (!['queued', 'running'].includes(op.status)) return op;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`operation ${id} did not finish`);
}

describe('bulk operations', () => {
  it('copies two files into a folder: 201 Operation, then done with new ids', async () => {
    const box = await scratchFolder(api, ctx, 'ops');
    const a = await uploadFile(api, box.id, 'a.txt', 'aaa');
    const b = await uploadFile(api, box.id, 'b.txt', 'bb');
    const target = (await api.mkdir(box.id, 'target')).json();
    const res = await api.post('/sync/v1/operations', { kind: 'copy', itemIds: [a.id, b.id], targetId: target.id });
    expect(res.status).toBe(201);
    expect(schemaErrors('Operation', res.json())).toBe('');
    const op = await waitDone(res.json().id);
    expect(schemaErrors('Operation', op)).toBe('');
    expect(op).toMatchObject({ status: 'done', totalItems: 2, doneItems: 2, totalBytes: 5 });
    const ids = op.results.map((r: { resultId: string }) => r.resultId);
    expect(ids).not.toContain(a.id);
    const children = (await api.get(`/sync/v1/items/${target.id}/children`)).json().items.map((i: { name: string }) => i.name).sort();
    expect(children).toEqual(['a.txt', 'b.txt']);
  });

  it('waits on a name conflict and resolves with keepBoth', async () => {
    const box = await scratchFolder(api, ctx, 'ops');
    const a = await uploadFile(api, box.id, 'a.txt', 'a');
    const target = (await api.mkdir(box.id, 'target')).json();
    await uploadFile(api, target.id, 'a.txt', 'old');
    const { id } = (await api.post('/sync/v1/operations', { kind: 'copy', itemIds: [a.id], targetId: target.id })).json();
    const waiting = await waitDone(id);
    expect(waiting.status).toBe('waiting');
    expect(schemaErrors('Operation', waiting)).toBe('');
    expect(waiting.conflict).toMatchObject({ sourceId: a.id, name: 'a.txt', canReplace: true });
    const r = await api.post(`/sync/v1/operations/${id}/resolve`, { action: 'keepBoth', applyToAll: false });
    expect(r.status).toBe(200);
    expect((await waitDone(id)).status).toBe('done');
    expect((await api.post(`/sync/v1/operations/${id}/resolve`, { action: 'skip', applyToAll: false })).status).toBe(409);
  });

  it('rejects a folder into itself (400 invalid_target) and unknown ids (404)', async () => {
    const box = await scratchFolder(api, ctx, 'ops');
    const sub = (await api.mkdir(box.id, 'sub')).json();
    const r = await api.post('/sync/v1/operations', { kind: 'move', itemIds: [box.id], targetId: sub.id });
    expect(r.status).toBe(400);
    expect(r.json().code).toBe('invalid_target');
    expect((await api.get('/sync/v1/operations/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('download-zip returns a one-time URL', async () => {
    const box = await scratchFolder(api, ctx, 'ops');
    const a = await uploadFile(api, box.id, 'a.txt', 'aaa');
    const t = await api.post('/sync/v1/download-zip', { itemIds: [a.id] });
    expect(t.status).toBe(200);
    expect(schemaErrors('ZipTicket', t.json())).toBe('');
    const zip = await api.get(t.json().url, { token: null });
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    expect((await api.get(t.json().url, { token: null })).status).toBe(404);
  });
});
