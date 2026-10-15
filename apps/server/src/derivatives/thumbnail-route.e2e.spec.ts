import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createTestApp, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import { WorkerRunner } from '../worker/worker-runner';
import { DerivedStore } from './derived-store';
import { HashBackfill } from './hash';
import { JobsService } from './jobs.service';
import { SearchLanguage } from '../search/search-language';
import { TextIndexer } from './text-index';
import { Thumbnailer } from './thumbnails';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');

describe('thumbnail route and preview field', () => {
  let ctx: TestContext; let token: string; let userId: string; let runner: WorkerRunner;
  const api = (method: string, url: string, opts: { body?: Buffer | string; headers?: Record<string, string>; as?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
  const upload = async (name: string, body: Buffer | string) => (await api('POST', `/items/upload?parentId=root&name=${encodeURIComponent(name)}`, { body })).json();

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
    runner = new WorkerRunner(ctx.config, new HashBackfill(ctx.prisma, ctx.config), new JobsService(ctx.prisma, ctx.config), new Thumbnailer(ctx.app.get(DerivedStore), ctx.config), new TextIndexer(ctx.prisma, new SearchLanguage(ctx.prisma, ctx.config)));
  });
  afterEach(async () => { await ctx.close(); });

  it('404 before processing, 200 webp with immutable caching after; 304 on If-None-Match', async () => {
    const item = await upload('pic.png', await readFile(path.join(FIXTURES, 'sample.png')));
    expect(item.preview).toEqual({ kind: 'image', thumbnail: false });
    const before = await api('GET', `/items/${item.id}/thumbnail?size=256`);
    expect(before.statusCode).toBe(404);
    expect(before.json().code).toBe('not_found');

    await runner.tick();
    for (const size of [256, 1024]) {
      const res = await api('GET', `/items/${item.id}/thumbnail?size=${size}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers.etag).toBe(`"${item.sha256}-${size}"`);
      expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect((await sharp(res.rawPayload).metadata()).format).toBe('webp');
    }
    expect((await api('GET', `/items/${item.id}/thumbnail`)).statusCode).toBe(200); // default 256
    const cached = await api('GET', `/items/${item.id}/thumbnail?size=256`, { headers: { 'if-none-match': `"${item.sha256}-256"` } });
    expect(cached.statusCode).toBe(304);
    expect((await api('GET', `/items/${item.id}`)).json().preview).toEqual({ kind: 'image', thumbnail: true });
  });

  it('size other than 256/1024 → 400; another user → 404; folders → 400', async () => {
    const item = await upload('pic.png', await readFile(path.join(FIXTURES, 'sample.png')));
    await runner.tick();
    expect((await api('GET', `/items/${item.id}/thumbnail?size=999`)).statusCode).toBe(400);
    const other = await ctx.prisma.user.create({ data: { username: 'eve', displayName: 'Eve' } });
    const eveToken = await ctx.app.get(AuthService).signAccess(other);
    const res = await api('GET', `/items/${item.id}/thumbnail?size=256`, { as: eveToken });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
    // A download token for the item works (img tags cannot send headers); one for another item does not.
    const dt = await ctx.app.get(AuthService).signDownloadToken(userId, item.id);
    const viaDt = await ctx.app.inject({ method: 'GET', url: `/api/sync/v1/items/${item.id}/thumbnail?size=256&dt=${encodeURIComponent(dt)}` });
    expect(viaDt.statusCode).toBe(200);
    const folder = (await ctx.app.inject({ method: 'POST', url: '/api/sync/v1/items', headers: { authorization: `Bearer ${token}` }, payload: { parentId: 'root', type: 'folder', name: 'F' } })).json();
    expect((await api('GET', `/items/${folder.id}/thumbnail`)).statusCode).toBe(400);
  });

  it('the SVG is served only as a rasterized webp thumbnail', async () => {
    const svg = await readFile(path.join(FIXTURES, 'script.svg'));
    const item = await upload('logo.svg', svg);
    await runner.tick();
    const res = await api('GET', `/items/${item.id}/thumbnail?size=1024`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.rawPayload.toString('latin1')).not.toContain('<script');
    expect((await api('GET', `/items/${item.id}`)).json().preview).toEqual({ kind: 'image', thumbnail: true });
  });

  it('preview field: kinds, code language, folders have none', async () => {
    await upload('main.ts', 'export {};');
    await upload('notes.md', '# hi');
    await upload('song.mp3', 'not really an mp3');
    await upload('blob.bin', 'x');
    await ctx.app.inject({ method: 'POST', url: '/api/sync/v1/items', headers: { authorization: `Bearer ${token}` }, payload: { parentId: 'root', type: 'folder', name: 'Dir' } });
    const page = (await api('GET', '/items/root/children')).json();
    const byName = Object.fromEntries(page.items.map((i: { name: string; preview?: unknown }) => [i.name, i.preview]));
    expect(byName).toEqual({
      Dir: undefined,
      'main.ts': { kind: 'code', thumbnail: false, language: 'typescript' },
      'notes.md': { kind: 'markdown', thumbnail: false },
      'song.mp3': { kind: 'audio', thumbnail: false },
      'blob.bin': { kind: 'none', thumbnail: false },
    });
  });
});
