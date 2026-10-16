import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import { SearchLanguage } from '../search/search-language';
import { WorkerRunner } from '../worker/worker-runner';
import { DerivedStore } from './derived-store';
import { FOLDER_THUMB_SCAN, folderThumbKey, FolderThumbnails } from './folder-thumbnails';
import { HashBackfill } from './hash';
import { JobsService } from './jobs.service';
import { TextIndexer } from './text-index';
import { Thumbnailer } from './thumbnails';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
type Rgb = { r: number; g: number; b: number };
const RED = { r: 230, g: 20, b: 20 }; const GREEN = { r: 20, g: 200, b: 20 };
const BLUE = { r: 20, g: 20, b: 230 }; const YELLOW = { r: 230, g: 220, b: 20 };
const GREY = { r: 128, g: 128, b: 128 };

const png = (c: Rgb) => sharp({ create: { width: 64, height: 48, channels: 3, background: c } }).png().toBuffer();
async function pixel(img: Buffer, x: number, y: number) {
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}
const near = (p: Rgb, c: Rgb) => Math.abs(p.r - c.r) < 40 && Math.abs(p.g - c.g) < 40 && Math.abs(p.b - c.b) < 40;

describe('folder thumbnails (mosaic of the children)', () => {
  let ctx: TestContext; let token: string; let userId: string; let runner: WorkerRunner;
  const api = (method: string, url: string, opts: { body?: Buffer | string; headers?: Record<string, string>; as?: string; payload?: object } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${opts.as ?? token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload ? { payload: opts.payload } : {}),
    });
  const mkdir = async (name: string, parentId = 'root', as?: string) =>
    (await api('POST', '/items', { payload: { parentId, type: 'folder', name }, as })).json();
  /** Uploads with a modification time `minutesAgo` before now (the mosaic orders by it). */
  const upload = async (parentId: string, name: string, body: Buffer | string, minutesAgo = 0, as?: string) => {
    const res = await api('POST', `/items/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, {
      body, as, headers: { 'x-synclet-modified-at': new Date(Date.now() - minutesAgo * 60_000).toISOString() },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  /** Runs the worker until it is idle (one pass handles `workerConcurrency` thumbnails). */
  const drain = async () => { for (let i = 0; i < 50 && (await runner.tick()); i++); };
  /** The item as the web grid lists it (parent's children with `folderThumbnails=1`). */
  const item = async (id: string, as?: string) => {
    const { parentId } = (await api('GET', `/items/${id}`, { as })).json();
    const page = (await api('GET', `/items/${parentId}/children?folderThumbnails=1`, { as })).json();
    return page.items.find((i: { id: string }) => i.id === id);
  };
  const thumb = (id: string, size = 256, as?: string, headers?: Record<string, string>) =>
    api('GET', `/items/${id}/thumbnail?size=${size}&composite=1`, { as, headers });

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
    runner = new WorkerRunner(ctx.config, new HashBackfill(ctx.prisma, ctx.config), new JobsService(ctx.prisma, ctx.config), new Thumbnailer(ctx.app.get(DerivedStore), ctx.config), new TextIndexer(ctx.prisma, new SearchLanguage(ctx.prisma, ctx.config)));
  });
  afterEach(async () => { await ctx.close(); });

  it('empty folders and folders without thumbnailable children have no thumbnail', async () => {
    const empty = await mkdir('Empty');
    const docs = await mkdir('Docs');
    await upload(docs.id, 'notes.txt', 'hello');
    const sub = await mkdir('Sub', docs.id);
    await upload(sub.id, 'deep.png', await png(RED)); // grandchildren do not count
    await drain();
    for (const f of [empty, docs]) {
      expect((await item(f.id)).preview).toBeUndefined();
      const res = await thumb(f.id);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('not_found');
    }
    // The subfolder itself has one.
    expect((await item(sub.id)).preview).toMatchObject({ kind: 'none', thumbnail: true });
  });

  it('a single picture fills the tile; the listing advertises it with a key', async () => {
    const f = await mkdir('Fotos');
    const pic = await upload(f.id, 'a.png', await png(RED));
    expect((await item(f.id)).preview).toBeUndefined(); // before the worker made the child's thumbnail
    await drain();
    const preview = (await item(f.id)).preview;
    expect(preview).toEqual({ kind: 'none', thumbnail: true, thumbnailKey: folderThumbKey([pic.sha256]) });
    // Only listings that ask for it carry it: not the plain listing, the item route or /changes.
    const plain = (await api('GET', '/items/root/children')).json().items.find((i: { id: string }) => i.id === f.id);
    expect(plain.preview).toBeUndefined();
    expect((await api('GET', `/items/${f.id}`)).json().preview).toBeUndefined();
    const changes = (await api('GET', '/changes?cursor=0')).json();
    const fromChanges = changes.changes.find((c: { item?: { id: string } }) => c.item?.id === f.id);
    expect(fromChanges.item.preview).toBeUndefined();

    for (const [size, w, h] of [[256, 256, 192], [1024, 1024, 768]] as const) {
      const res = await thumb(f.id, size);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers.etag).toBe(`"${preview.thumbnailKey}-${size}"`);
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const meta = await sharp(res.rawPayload).metadata();
      expect({ format: meta.format, w: meta.width, h: meta.height }).toEqual({ format: 'webp', w, h });
      expect(near(await pixel(res.rawPayload, 10, 10), RED)).toBe(true);
      expect(near(await pixel(res.rawPayload, w - 10, h - 10), RED)).toBe(true);
    }
    const again = await thumb(f.id, 256, undefined, { 'if-none-match': `"${preview.thumbnailKey}-256"` });
    expect(again.statusCode).toBe(304);
    // Cached in the derived store.
    expect(await ctx.app.get(DerivedStore).has(ctx.app.get(DerivedStore).folderThumbPath(preview.thumbnailKey, 256))).toBe(true);
  });

  it('two side by side; four or more: the four most recently modified in a 2×2 grid, duplicates once', async () => {
    const f = await mkdir('Mix');
    await upload(f.id, 'old.png', await png(GREY), 50);
    await upload(f.id, 'b.png', await png(GREEN), 20);
    const a = await upload(f.id, 'a.png', await png(RED), 10);
    await drain();
    let res = await thumb(f.id);
    // Three: the newest (red) large on the left, green and grey stacked on the right.
    expect(res.statusCode).toBe(200);
    expect(near(await pixel(res.rawPayload, 30, 170), RED)).toBe(true);
    expect(near(await pixel(res.rawPayload, 220, 30), GREEN)).toBe(true);
    expect(near(await pixel(res.rawPayload, 220, 170), GREY)).toBe(true);

    const two = await mkdir('Two');
    await upload(two.id, 'x.png', await png(BLUE), 5);
    await upload(two.id, 'y.png', await png(YELLOW), 1);
    await upload(two.id, 'copy.png', await png(YELLOW), 2); // same content as y: shown once
    await drain();
    res = await thumb(two.id);
    expect(near(await pixel(res.rawPayload, 30, 30), YELLOW)).toBe(true);
    expect(near(await pixel(res.rawPayload, 30, 170), YELLOW)).toBe(true);
    expect(near(await pixel(res.rawPayload, 220, 30), BLUE)).toBe(true);
    expect(near(await pixel(res.rawPayload, 220, 170), BLUE)).toBe(true);

    await upload(f.id, 'c.png', await png(BLUE), 5);
    await upload(f.id, 'd.png', await png(YELLOW), 1);
    await upload(f.id, 'clip.pdf', await readFile(path.join(FIXTURES, 'sample.pdf')), 100);
    await drain();
    res = await thumb(f.id);
    expect(near(await pixel(res.rawPayload, 30, 30), YELLOW)).toBe(true);
    expect(near(await pixel(res.rawPayload, 220, 30), BLUE)).toBe(true);
    expect(near(await pixel(res.rawPayload, 30, 170), RED)).toBe(true);
    expect(near(await pixel(res.rawPayload, 220, 170), GREEN)).toBe(true);
    const shas = (await ctx.prisma.item.findMany({ where: { parentId: f.id.slice(2), name: { in: ['d.png', 'c.png', 'b.png'] } } }))
      .sort((x, y) => y.mtime.getTime() - x.mtime.getTime()).map((r) => r.contentHash!);
    expect((await item(f.id)).preview.thumbnailKey).toBe(folderThumbKey([shas[0], shas[1], a.sha256, shas[2]]));
  });

  it('the key changes when a child is replaced, added or deleted', async () => {
    const f = await mkdir('Change');
    const pic = await upload(f.id, 'a.png', await png(RED));
    await drain();
    const k1 = (await item(f.id)).preview.thumbnailKey;

    const put = await api('PUT', `/items/${pic.id}/content`, { body: await png(BLUE), headers: { 'if-match': '*' } });
    expect(put.statusCode).toBe(200);
    // Until the worker has the new content's thumbnail, the folder has none.
    expect((await item(f.id)).preview).toBeUndefined();
    await drain();
    const k2 = (await item(f.id)).preview.thumbnailKey;
    expect(k2).not.toBe(k1);
    expect(near(await pixel((await thumb(f.id)).rawPayload, 128, 96), BLUE)).toBe(true);

    const other = await upload(f.id, 'b.png', await png(GREEN));
    await drain();
    const k3 = (await item(f.id)).preview.thumbnailKey;
    expect(k3).not.toBe(k2);

    expect((await api('DELETE', `/items/${other.id}`)).statusCode).toBeLessThan(300);
    expect((await item(f.id)).preview.thumbnailKey).toBe(k2);
  });

  it(`only the ${FOLDER_THUMB_SCAN} newest files are considered: older pictures do not make a mosaic`, async () => {
    const f = await mkdir('Big');
    await upload(f.id, 'old.png', await png(RED), 60);
    await drain();
    expect((await item(f.id)).preview).toMatchObject({ thumbnail: true });
    const folderRow = await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id.slice(2) } });
    const now = Date.now();
    await ctx.prisma.item.createMany({
      data: Array.from({ length: FOLDER_THUMB_SCAN }, (_, i) => ({
        spaceId: folderRow.spaceId, parentId: folderRow.id, type: 'file' as const, name: `n${i}.txt`, nameKey: `n${i}.txt`,
        path: `${folderRow.path}/n${i}.txt`, size: 1n, mtime: new Date(now - i * 1000),
      })),
    });
    expect((await item(f.id)).preview).toBeUndefined();
    expect((await thumb(f.id)).statusCode).toBe(404);
    // One of them fewer: the picture is within reach again.
    await ctx.prisma.item.deleteMany({ where: { parentId: folderRow.id, name: 'n0.txt' } });
    expect((await item(f.id)).preview).toMatchObject({ thumbnail: true });
  });

  it('a child thumbnail that cannot be decoded → 404 and that child requeued; fine after the worker', async () => {
    const f = await mkdir('Broken');
    const pic = await upload(f.id, 'a.png', await png(RED));
    await drain();
    await writeFile(ctx.app.get(DerivedStore).pathFor(pic.sha256, 'thumb', 1024), 'not a webp');
    expect((await thumb(f.id)).statusCode).toBe(404);
    expect(await ctx.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha: pic.sha256, kind: 'thumb' } } })).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await item(f.id)).preview).toBeUndefined(); // not chosen while it is being regenerated
    await drain();
    expect((await thumb(f.id)).statusCode).toBe(200);
  });

  it('a mosaic removed (GC) between being found and opened is rebuilt', async () => {
    const f = await mkdir('Race');
    await upload(f.id, 'a.png', await png(RED));
    await drain();
    expect((await thumb(f.id)).statusCode).toBe(200);
    const thumbs = ctx.app.get(FolderThumbnails);
    const real = thumbs.thumbnail.bind(thumbs);
    const store = ctx.app.get(DerivedStore);
    // The GC strikes right after the mosaic was found.
    const spy = jest.spyOn(thumbs, 'thumbnail').mockImplementationOnce(async (...args) => {
      const found = await real(...args);
      await rm(found!.path);
      return found;
    });
    const res = await thumb(f.id);
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await store.has(store.folderThumbPath((await item(f.id)).preview.thumbnailKey, 256))).toBe(true);
  });

  it('folders answer 400 without ?composite=1 (sync clients unchanged); roots never have one', async () => {
    const f = await mkdir('F');
    await upload(f.id, 'a.png', await png(RED));
    await drain();
    expect((await api('GET', `/items/${f.id}/thumbnail`)).statusCode).toBe(400);
    expect((await api('GET', `/items/${f.id}/thumbnail?composite=1&size=999`)).statusCode).toBe(400);
    expect((await api('GET', '/items/root/thumbnail?composite=1')).statusCode).toBe(400);
    expect((await thumb(f.id)).statusCode).toBe(200);
  });

  it('a child whose thumbnail files are gone → 404 and the child requeued; served again after the worker', async () => {
    const f = await mkdir('Lost');
    const pic = await upload(f.id, 'a.png', await png(RED));
    await drain();
    await rm(ctx.app.get(DerivedStore).root, { recursive: true, force: true });
    expect((await thumb(f.id)).statusCode).toBe(404);
    expect(await ctx.prisma.derivativeJob.findUnique({ where: { sha_kind: { sha: pic.sha256, kind: 'thumb' } } })).toMatchObject({ status: 'pending' });
    await drain();
    expect((await thumb(f.id)).statusCode).toBe(200);
  });

  it('access: other users 404; read members of a team space get it; preview tokens for folders work only there', async () => {
    const f = await mkdir('Private');
    await upload(f.id, 'a.png', await png(RED));
    await drain();
    const auth = ctx.app.get(AuthService);
    const eve = await createTestUser(ctx, 'eve');
    const eveToken = await auth.signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: eve.id } }));
    expect((await thumb(f.id, 256, eveToken)).statusCode).toBe(404);

    // A preview token for a folder: thumbnail only; no download tokens for folders.
    expect((await api('POST', `/items/${f.id}/download-token`)).statusCode).toBe(400);
    const minted = await api('POST', `/items/${f.id}/download-token?purpose=preview`);
    expect(minted.statusCode).toBe(201);
    const { url, token: dt } = minted.json();
    expect(url).toBe(`/api/sync/v1/items/${f.id}/thumbnail?composite=1&dt=${encodeURIComponent(dt)}`);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sync/v1${url.slice('/api/sync/v1'.length)}` })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sync/v1/items/${f.id}/content?dt=${encodeURIComponent(dt)}` })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sync/v1/items/${f.id}/children?dt=${encodeURIComponent(dt)}` })).statusCode).toBe(401);
    const other = await mkdir('Other');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/sync/v1/items/${other.id}/thumbnail?composite=1&dt=${encodeURIComponent(dt)}` })).statusCode).toBe(401);

    // Team space: a read member sees the folder's mosaic; a non-member does not.
    const team = await createTestSpace(ctx, 'Familie');
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId, role: 'write' } });
    await ctx.prisma.spaceMember.create({ data: { spaceId: team.id, userId: eve.id, role: 'read' } });
    const tf = await mkdir('Urlaub', `r_${team.id}`);
    await upload(tf.id, 'b.png', await png(GREEN));
    await drain();
    expect((await item(tf.id, eveToken)).preview).toMatchObject({ thumbnail: true });
    expect((await thumb(tf.id, 256, eveToken)).statusCode).toBe(200);
    await ctx.prisma.spaceMember.deleteMany({ where: { spaceId: team.id, userId: eve.id } });
    expect((await thumb(tf.id, 256, eveToken)).statusCode).toBe(404);
  });

  it('public folder shares: subfolders with pictures have a thumbnail', async () => {
    const shared = await mkdir('Shared');
    const sub = await mkdir('Album', shared.id);
    await upload(sub.id, 'a.png', await png(RED));
    const plain = await mkdir('Plain', shared.id);
    await drain();
    const created = await ctx.app.inject({ method: 'POST', url: '/api/shares', headers: { authorization: `Bearer ${token}` }, payload: { itemId: shared.id } });
    expect(created.statusCode).toBe(201);
    const shareToken = created.json().url.split('/s/')[1];
    const pub = (url: string) => ctx.app.inject({ method: 'GET', url: `/api/public/shares/${shareToken}/${url}`, remoteAddress: '203.0.113.1' });
    const entries = (await pub('items')).json();
    const byName = Object.fromEntries(entries.map((e: { name: string; hasThumbnail: boolean }) => [e.name, e.hasThumbnail]));
    expect(byName).toEqual({ Album: true, Plain: false });
    const res = await pub(`items/${sub.id}/thumbnail?size=256`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(near(await pixel(res.rawPayload, 128, 96), RED)).toBe(true);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const revalidated = await ctx.app.inject({ method: 'GET', url: `/api/public/shares/${shareToken}/items/${sub.id}/thumbnail?size=256`, remoteAddress: '203.0.113.1', headers: { 'if-none-match': res.headers.etag as string } });
    expect(revalidated.statusCode).toBe(304);
    expect((await pub(`items/${plain.id}/thumbnail?size=256`)).statusCode).toBe(404);
    // Outside the share: 404.
    const outside = await mkdir('Outside');
    await upload(outside.id, 'b.png', await png(BLUE));
    await drain();
    expect((await pub(`items/${outside.id}/thumbnail?size=256`)).statusCode).toBe(404);
  });
});
