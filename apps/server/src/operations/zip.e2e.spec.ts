import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as yauzl from 'yauzl';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import type { IndexUser } from '../common/types';
import { ZIP_TICKET_TTL_MS } from './zip-tickets';

/** Entry names and file contents of a ZIP (same helper as in public-shares.e2e.spec.ts). */
function unzip(buf: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, string>();
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          out.set(entry.fileName, '');
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => { out.set(entry.fileName, Buffer.concat(chunks).toString()); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

describe('multi-item ZIP download', () => {
  let ctx: TestContext; let alice: IndexUser; let token: string;
  const api = (method: string, url: string, opts: { payload?: unknown; body?: string; as?: string | null } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: {
        ...(opts.as === null ? {} : { authorization: `Bearer ${opts.as ?? token}` }),
        ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const tokenOf = async (u: IndexUser) => ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.id } }));
  const mkdir = async (parentId: string, name: string) => (await api('POST', '/items', { payload: { parentId, type: 'folder', name } })).json();
  const upload = async (parentId: string, name: string, body: string) => (await api('POST', `/items/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, { body })).json();
  const ticket = async (itemIds: string[], as?: string) => api('POST', '/download-zip', { payload: { itemIds }, as });
  const fetchZip = (url: string) => ctx.app.inject({ method: 'GET', url });

  beforeEach(async () => {
    ctx = await createTestApp();
    alice = await createTestUser(ctx, 'alice');
    token = await tokenOf(alice);
  });
  afterEach(async () => { await ctx.close(); jest.useRealTimers(); });

  it('zips several files and folders; the ticket works once and without a token', async () => {
    const docs = await mkdir('root', 'Docs');
    const sub = await mkdir(docs.id, 'Sub');
    await upload(sub.id, 'b.txt', 'bb');
    const a = await upload('root', 'a.txt', 'aaa');
    const t = await ticket([docs.id, a.id]);
    expect(t.statusCode).toBe(200);
    expect(t.json().url).toMatch(/^\/api\/sync\/v1\/zip\/[A-Za-z0-9_-]{20,}$/);
    const res = await fetchZip(t.json().url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="Synclet-\d{4}-\d{2}-\d{2}\.zip"/);
    expect(await unzip(res.rawPayload)).toEqual(new Map([['Docs/', ''], ['Docs/Sub/', ''], ['Docs/Sub/b.txt', 'bb'], ['a.txt', 'aaa']]));
    expect((await fetchZip(t.json().url)).statusCode).toBe(404); // once only
  });

  it('one folder is named after it; same names from different folders get a suffix', async () => {
    const docs = await mkdir('root', 'Docs');
    const one = await fetchZip((await ticket([docs.id])).json().url);
    expect(String(one.headers['content-disposition'])).toContain('filename="Docs.zip"');
    const x = await mkdir('root', 'X');
    const y = await mkdir('root', 'Y');
    const f1 = await upload(x.id, 'n.txt', '1');
    const f2 = await upload(y.id, 'n.txt', '2');
    const both = await fetchZip((await ticket([f1.id, f2.id])).json().url);
    expect(await unzip(both.rawPayload)).toEqual(new Map([['n.txt', '1'], ['n (2).txt', '2']]));
  });

  it('expired, unknown and foreign items', async () => {
    const a = await upload('root', 'a.txt', 'a');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const t = (await ticket([a.id])).json();
    jest.setSystemTime(Date.now() + ZIP_TICKET_TTL_MS + 1000);
    expect((await fetchZip(t.url)).statusCode).toBe(404);
    jest.useRealTimers();
    expect((await fetchZip('/api/sync/v1/zip/nope')).statusCode).toBe(404);
    expect((await ticket([])).statusCode).toBe(400);
    expect((await ticket(['root'])).statusCode).toBe(400);
    const bob = await createTestUser(ctx, 'bob');
    expect((await ticket([a.id], await tokenOf(bob))).statusCode).toBe(404);
    expect((await api('POST', '/download-zip', { payload: { itemIds: [a.id] }, as: null })).statusCode).toBe(401);
  });

  it('re-checks access when the ticket is redeemed', async () => {
    const team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: alice.id, role: 'read' } });
    const f = await ctx.prisma.item.create({ data: { spaceId: team.id, parentId: null, type: 'file', name: 't.txt', nameKey: 't.txt', path: 't.txt', size: 1n, mtime: new Date() } });
    const t = (await ticket([`f_${f.id}`])).json();
    await ctx.prisma.spaceMember.deleteMany({ where: { spaceId: team.id } });
    expect((await fetchZip(t.url)).statusCode).toBe(404);
    // The refused redemption consumed the ticket: access back, the same URL stays dead.
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: alice.id, role: 'read' } });
    expect((await fetchZip(t.url)).statusCode).toBe(404);
    await writeFile(path.join(team.rootPath, 't.txt'), 't');
    const fresh = await fetchZip((await ticket([`f_${f.id}`])).json().url);
    expect(fresh.statusCode).toBe(200);
    expect(await unzip(fresh.rawPayload)).toEqual(new Map([['t.txt', 't']]));
  });
});
