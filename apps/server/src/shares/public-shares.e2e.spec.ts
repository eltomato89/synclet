import type { ShareLinkWire } from '@synclet/shared';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as yauzl from 'yauzl';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { RateLimiter } from '../auth/rate-limit';
import { DerivedStore } from '../derivatives/derived-store';
import { FilesService } from '../files/files.service';
import { IndexerService } from '../indexer/indexer.service';
import { ShareRateLimits, unlockCookieName } from './share-auth';

type Res = Awaited<ReturnType<TestContext['app']['inject']>>;

/** Entry names and file contents of a ZIP. */
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

describe('Share links', () => {
  let ctx: TestContext; let token: string; let userId: string;
  const api = (method: string, url: string, opts: { payload?: unknown; body?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api${url}`,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const pub = (method: string, url: string, opts: { payload?: unknown; body?: string; cookies?: Record<string, string>; ip?: string; headers?: Record<string, string> } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/public/shares/${url}`,
      remoteAddress: opts.ip ?? '203.0.113.1',
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      cookies: opts.cookies,
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const upload = async (parentId: string, name: string, body: string) => (await api('POST', `/sync/v1/items/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, { body })).json();
  const folder = async (parentId: string, name: string) => (await api('POST', '/sync/v1/items', { payload: { parentId, type: 'folder', name } })).json();
  const share = async (itemId: string, extra: Record<string, unknown> = {}): Promise<ShareLinkWire & { token: string }> => {
    const res = await api('POST', '/shares', { payload: { itemId, ...extra } });
    expect(res.statusCode).toBe(201);
    const wire = res.json() as ShareLinkWire;
    return { ...wire, token: wire.url.split('/s/')[1] };
  };
  const cookieOf = (res: Res) => {
    const c = res.cookies.find((x) => x.name.startsWith('synclet_share_'));
    return c ? { [c.name]: c.value } : undefined;
  };
  const userRoot = () => path.join(ctx.config.dataRoot, 'jens');

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens Owner', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
  });
  afterEach(async () => { await ctx.close(); });

  /** P/A (shared) with a.txt, sub/x.txt, empty/; outside: P/B/secret.txt, P/Ax/f.txt, top.txt. */
  async function tree() {
    const P = await folder('root', 'P');
    const A = await folder(P.id, 'A');
    const sub = await folder(A.id, 'sub');
    const empty = await folder(A.id, 'empty');
    const a = await upload(A.id, 'a.txt', 'alpha');
    const x = await upload(sub.id, 'x.txt', 'inside x');
    const B = await folder(P.id, 'B');
    const secret = await upload(B.id, 'secret.txt', 'secret');
    const bx = await upload(B.id, 'x.txt', 'outside x');
    const Ax = await folder(P.id, 'Ax');
    const ax = await upload(Ax.id, 'f.txt', 'prefix sibling');
    const top = await upload('root', 'top.txt', 'top');
    return { P, A, sub, empty, a, x, B, secret, bx, Ax, ax, top };
  }

  describe('owner API', () => {
    it('creates, lists, patches, rotates and revokes', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      expect(s).toMatchObject({ itemId: t.A.id, itemName: 'A', itemType: 'folder', hasPassword: false, allowDownload: true, allowUpload: false, revokedAt: null, hits: 0, expiresAt: null });
      expect(s.url).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
      // The token is stored only as hash + ciphertext.
      const row = await ctx.prisma.shareLink.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.tokenHash).not.toContain(s.token);
      expect(row.tokenEnc).not.toContain(s.token);
      expect(row.tokenEnc.split('.')).toHaveLength(3);

      const s2 = await share(t.a.id, { password: 'pw', expiresAt: new Date(Date.now() + 3600_000).toISOString(), allowDownload: false });
      expect(s2).toMatchObject({ itemType: 'file', hasPassword: true, allowDownload: false });
      expect((await api('GET', '/shares')).json().map((x: ShareLinkWire) => x.id)).toEqual([s2.id, s.id]);
      const byItem = (await api('GET', `/shares?itemId=${t.A.id}`)).json();
      expect(byItem).toEqual([expect.objectContaining({ id: s.id, url: s.url })]); // same link can be copied again

      const p = await api('PATCH', `/shares/${s.id}`, { payload: { password: 'secret', allowUpload: true, expiresAt: null } });
      expect(p.json()).toMatchObject({ hasPassword: true, allowUpload: true, url: s.url });
      expect((await api('PATCH', `/shares/${s.id}`, { payload: { password: null } })).json().hasPassword).toBe(false);
      expect((await api('PATCH', `/shares/${s2.id}`, { payload: { allowUpload: true } })).json().code).toBe('invalid_request');
      expect((await api('PATCH', `/shares/${s.id}`, { payload: { expiresAt: '2000-01-01T00:00:00Z' } })).statusCode).toBe(400);
      expect((await api('PATCH', `/shares/${s.id}`, { payload: { bogus: 1 } })).statusCode).toBe(400);

      const r = await api('POST', `/shares/${s.id}/rotate`);
      expect(r.statusCode).toBe(200);
      const rotated = r.json() as ShareLinkWire;
      expect(rotated.url).not.toBe(s.url);
      expect((await pub('GET', s.token)).statusCode).toBe(404);
      expect((await pub('GET', rotated.url.split('/s/')[1])).statusCode).toBe(200);

      expect((await api('DELETE', `/shares/${s.id}`)).statusCode).toBe(204);
      expect((await pub('GET', rotated.url.split('/s/')[1])).json().code).toBe('not_found');
      expect((await api('GET', '/shares')).json().map((x: ShareLinkWire) => x.id)).toEqual([s2.id]);
      expect((await api('PATCH', `/shares/${s.id}`, { payload: { allowDownload: false } })).statusCode).toBe(404);
      expect((await api('POST', `/shares/${s.id}/rotate`)).statusCode).toBe(404);
    });

    it('rejects foreign, missing and invalid items; shares of other users are invisible', async () => {
      const t = await tree();
      expect((await api('POST', '/shares', { payload: { itemId: 'root' } })).statusCode).toBe(400);
      expect((await api('POST', '/shares', { payload: { itemId: 'd_3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab' } })).statusCode).toBe(404);
      expect((await api('POST', '/shares', { payload: { itemId: t.a.id, allowUpload: true } })).statusCode).toBe(400);
      const bob = await createTestUser(ctx, 'bob');
      const bobFile = await ctx.app.get(FilesService).upload(bob, null, 'b.txt', Readable.from([Buffer.from('bob')]), {});
      expect((await api('POST', '/shares', { payload: { itemId: `f_${bobFile.id}` } })).statusCode).toBe(404);
      const bobShare = await ctx.prisma.shareLink.create({ data: { ownerId: bob.id, itemId: bobFile.id, tokenHash: 'x', tokenEnc: 'y' } });
      expect((await api('GET', '/shares')).json()).toEqual([]);
      expect((await api('PATCH', `/shares/${bobShare.id}`, { payload: { allowDownload: false } })).statusCode).toBe(404);
      expect((await api('DELETE', `/shares/${bobShare.id}`)).statusCode).toBe(404);
      expect((await api('DELETE', '/shares/not-a-uuid')).statusCode).toBe(404);
      expect((await ctx.app.inject({ method: 'GET', url: '/api/shares' })).statusCode).toBe(401);
    });
  });

  describe('public API', () => {
    it('info for file and folder shares; hits count info requests', async () => {
      const t = await tree();
      const f = await share(t.a.id);
      expect((await pub('GET', f.token)).json()).toEqual({
        name: 'a.txt', type: 'file', size: 5, mime: 'text/plain', ownerDisplayName: 'Jens Owner',
        allowDownload: true, allowUpload: false, expiresAt: null,
      });
      const d = await share(t.A.id, { allowUpload: true });
      const info = await pub('GET', d.token);
      expect(info.json()).toMatchObject({ name: 'A', type: 'folder', size: 'alpha'.length + 'inside x'.length, mime: null, allowUpload: true });
      expect(info.headers['x-robots-tag']).toContain('noindex');
      expect(info.headers['cache-control']).toBe('private, no-store');
      await pub('GET', d.token);
      await pub('GET', `${d.token}/items`);
      expect((await api('GET', `/shares?itemId=${t.A.id}`)).json()[0].hits).toBe(2);
    });

    it('unknown and malformed tokens 404, revoked 404, expired 410, trashed item 404', async () => {
      const t = await tree();
      expect((await pub('GET', 'A'.repeat(43))).json().code).toBe('not_found');
      expect((await pub('GET', 'short')).statusCode).toBe(404);
      expect((await pub('GET', `${'A'.repeat(43)}/items`)).statusCode).toBe(404);
      const s = await share(t.A.id);
      await ctx.prisma.shareLink.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await pub('GET', s.token)).json().code).toBe('share_expired');
      expect((await pub('GET', s.token)).statusCode).toBe(410);
      expect((await pub('GET', `${s.token}/items/${t.a.id}/content`)).statusCode).toBe(410);
      await ctx.prisma.shareLink.update({ where: { id: s.id }, data: { expiresAt: null, revokedAt: new Date() } });
      expect((await pub('GET', s.token)).statusCode).toBe(404);
      const s2 = await share(t.sub.id);
      await api('DELETE', `/sync/v1/items/${t.sub.id}`);
      expect((await pub('GET', s2.token)).statusCode).toBe(404);
    });

    it('password flow: 401 until unlocked; the cookie is bound to its share and password', async () => {
      const t = await tree();
      const s = await share(t.A.id, { password: 'open sesame' });
      const other = await share(t.B.id, { password: 'open sesame' });
      expect((await pub('GET', s.token)).json().code).toBe('share_password_required');
      expect((await pub('GET', `${s.token}/items`)).statusCode).toBe(401);
      expect((await pub('GET', `${s.token}/items/${t.a.id}/content`)).statusCode).toBe(401);
      const wrong = await pub('POST', `${s.token}/unlock`, { payload: { password: 'nope' } });
      expect(wrong.statusCode).toBe(401);
      expect(cookieOf(wrong)).toBeUndefined();
      const ok = await pub('POST', `${s.token}/unlock`, { payload: { password: 'open sesame' } });
      expect(ok.statusCode).toBe(204);
      const c = ok.cookies.find((x) => x.name === unlockCookieName(s.id))!;
      expect(c).toMatchObject({ path: `/api/public/shares/${s.token}`, httpOnly: true, sameSite: 'Lax', maxAge: 12 * 3600 });
      const cookies = cookieOf(ok)!;
      expect((await pub('GET', s.token, { cookies })).statusCode).toBe(200);
      expect((await pub('GET', `${s.token}/items/${t.a.id}/content`, { cookies })).body).toBe('alpha');
      // Share A's unlock presented for share B (under B's cookie name): rejected.
      expect((await pub('GET', other.token, { cookies: { [unlockCookieName(other.id)]: c.value } })).statusCode).toBe(401);
      expect((await pub('GET', other.token, { cookies })).statusCode).toBe(401);
      // Garbage cookie.
      expect((await pub('GET', s.token, { cookies: { [unlockCookieName(s.id)]: 'x.y.z' } })).statusCode).toBe(401);
      // Changing the password invalidates earlier unlocks.
      await api('PATCH', `/shares/${s.id}`, { payload: { password: 'new password' } });
      expect((await pub('GET', s.token, { cookies })).statusCode).toBe(401);
    });

    it('rate limits password checks and requests per IP', async () => {
      const t = await tree();
      const s = await share(t.A.id, { password: 'pw' });
      for (let i = 0; i < 5; i++) expect((await pub('POST', `${s.token}/unlock`, { payload: { password: 'bad' } })).statusCode).toBe(401);
      const limited = await pub('POST', `${s.token}/unlock`, { payload: { password: 'pw' } });
      expect(limited.statusCode).toBe(429);
      expect(limited.json().code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Another client is not affected.
      expect((await pub('POST', `${s.token}/unlock`, { payload: { password: 'pw' }, ip: '198.51.100.7' })).statusCode).toBe(204);

      ctx.app.get(ShareRateLimits).requests = new RateLimiter({ capacity: 3, refillPerSec: 0.001 });
      for (let i = 0; i < 3; i++) expect((await pub('GET', 'A'.repeat(43), { ip: '192.0.2.9' })).statusCode).toBe(404);
      expect((await pub('GET', s.token, { ip: '192.0.2.9' })).statusCode).toBe(429);
    });

    it('browses the shared folder and its live descendants only', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      const root = (await pub('GET', `${s.token}/items`)).json();
      expect(root.map((e: { name: string; type: string }) => `${e.type}:${e.name}`)).toEqual(['folder:empty', 'folder:sub', 'file:a.txt']);
      expect(root[2]).toEqual({ id: t.a.id, name: 'a.txt', type: 'file', size: 5, mime: 'text/plain', modifiedAt: t.a.modifiedAt, hasThumbnail: false });
      expect((await pub('GET', `${s.token}/items?folder=${t.sub.id}`)).json().map((e: { name: string }) => e.name)).toEqual(['x.txt']);
      expect((await pub('GET', `${s.token}/items?folder=${t.A.id}`)).statusCode).toBe(200);
      // A file share has no listing.
      const f = await share(t.a.id);
      expect((await pub('GET', `${f.token}/items`)).statusCode).toBe(400);
    });

    it('scope escape: ids outside the share, other users, parents and prefix siblings are 404', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      const bob = await createTestUser(ctx, 'bob');
      const bobFile = await ctx.app.get(FilesService).upload(bob, null, 'b.txt', Readable.from([Buffer.from('bob')]), {});
      const outside = [t.secret.id, t.bx.id, t.ax.id, t.top.id, `f_${bobFile.id}`, bobFile.id];
      for (const id of outside) {
        expect((await pub('GET', `${s.token}/items/${id}/content`)).statusCode).toBe(404);
        expect((await pub('GET', `${s.token}/items/${id}/thumbnail`)).statusCode).toBe(404);
      }
      for (const f of [t.P.id, t.B.id, t.Ax.id, 'root', '..', '../B', t.a.id]) {
        expect((await pub('GET', `${s.token}/items?folder=${encodeURIComponent(f)}`)).statusCode).toBe(404);
        expect((await pub('GET', `${s.token}/zip?folder=${encodeURIComponent(f)}`)).statusCode).toBe(404);
      }
      expect((await pub('GET', `${s.token}/items/..%2F..%2Fetc%2Fpasswd/content`)).statusCode).toBe(404);
      // A file share serves only that file.
      const f = await share(t.a.id);
      expect((await pub('GET', `${f.token}/items/${t.a.id}/content`)).body).toBe('alpha');
      expect((await pub('GET', `${f.token}/items/${t.x.id}/content`)).statusCode).toBe(404);
      // Trashed descendants are gone.
      await api('DELETE', `/sync/v1/items/${t.x.id}`);
      expect((await pub('GET', `${s.token}/items/${t.x.id}/content`)).statusCode).toBe(404);
    });

    it('follows the shared folder when it is moved and stays scoped', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      const Q = await folder('root', 'Q');
      const moved = await api('PATCH', `/sync/v1/items/${t.A.id}`, { payload: { parentId: Q.id, name: 'A2' } });
      expect(moved.statusCode).toBe(200);
      expect((await pub('GET', s.token)).json().name).toBe('A2');
      expect((await pub('GET', `${s.token}/items/${t.x.id}/content`)).body).toBe('inside x');
      expect((await pub('GET', `${s.token}/items?folder=${t.sub.id}`)).statusCode).toBe(200);
      // A sibling whose path starts with the new path is still outside.
      const sib = await folder(Q.id, 'A2x');
      const sibFile = await upload(sib.id, 'z.txt', 'z');
      expect((await pub('GET', `${s.token}/items/${sibFile.id}/content`)).statusCode).toBe(404);
      expect((await pub('GET', `${s.token}/items?folder=${Q.id}`)).statusCode).toBe(404);
      expect((await pub('GET', `${s.token}/items/${t.secret.id}/content`)).statusCode).toBe(404);
    });

    it('symlinks on disk are neither listed nor followed', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      // A symlink created on the host is never indexed, hence never listed.
      await symlink(path.join(userRoot(), 'P', 'B'), path.join(userRoot(), 'P', 'A', 'link'));
      await ctx.app.get(IndexerService).fullScan({ id: userId, username: 'jens' });
      const names = (await pub('GET', `${s.token}/items`)).json().map((e: { name: string }) => e.name);
      expect(names).not.toContain('link');
      // An indexed subfolder swapped for a symlink to outside (before the indexer notices) is not served.
      await rename(path.join(userRoot(), 'P', 'A', 'sub'), path.join(userRoot(), 'P', 'sub-moved'));
      await symlink(path.join(userRoot(), 'P', 'B'), path.join(userRoot(), 'P', 'A', 'sub'));
      expect((await pub('GET', `${s.token}/items/${t.x.id}/content`)).statusCode).toBe(404);
      expect((await pub('GET', `${s.token}/items?folder=${t.sub.id}`)).statusCode).toBe(404);
      const zip = await pub('GET', `${s.token}/zip`);
      expect(zip.statusCode).toBe(200);
      const entries = await unzip(zip.rawPayload);
      expect(entries.get('sub/x.txt')).toBeUndefined();
      expect([...entries.values()]).not.toContain('outside x');
      // The same for the shared folder itself.
      await rename(path.join(userRoot(), 'P', 'A'), path.join(userRoot(), 'P', 'A-moved'));
      await symlink(path.join(userRoot(), 'P', 'B'), path.join(userRoot(), 'P', 'A'));
      expect((await pub('GET', `${s.token}/items`)).statusCode).toBe(404);
      expect((await pub('GET', `${s.token}/items/${t.a.id}/content`)).statusCode).toBe(404);
    });

    it('serves content with range, etag and sandbox headers; download=1 as attachment', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      const res = await pub('GET', `${s.token}/items/${t.a.id}/content`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('alpha');
      expect(res.headers).toMatchObject({ etag: '"v1"', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' });
      expect(res.headers['content-security-policy']).toContain('sandbox');
      expect(res.headers['content-disposition']).toBeUndefined();
      const part = await pub('GET', `${s.token}/items/${t.a.id}/content`, { headers: { range: 'bytes=1-2' } });
      expect(part.statusCode).toBe(206);
      expect(part.body).toBe('lp');
      expect((await pub('GET', `${s.token}/items/${t.a.id}/content`, { headers: { 'if-none-match': '"v1"' } })).statusCode).toBe(304);
      const dl = await pub('GET', `${s.token}/items/${t.a.id}/content?download=1`);
      expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''a.txt");
      expect((await pub('GET', `${s.token}/items/${t.sub.id}/content`)).statusCode).toBe(404); // folders have no content
    });

    it('allowDownload=false blocks downloads and zip but keeps inline previews of images', async () => {
      const t = await tree();
      const png = await upload(t.A.id, 'pic.png', 'not really a png');
      const bin = await upload(t.A.id, 'data.bin', 'raw');
      const s = await share(t.A.id, { allowDownload: false });
      expect((await pub('GET', `${s.token}/items/${png.id}/content?download=1`)).statusCode).toBe(403);
      const inline = await pub('GET', `${s.token}/items/${png.id}/content`);
      expect(inline.statusCode).toBe(200);
      expect(inline.headers['content-type']).toBe('image/png');
      expect(inline.headers['content-security-policy']).toContain('sandbox');
      expect((await pub('GET', `${s.token}/items/${t.a.id}/content`)).statusCode).toBe(200); // text preview
      expect((await pub('GET', `${s.token}/items/${bin.id}/content`)).statusCode).toBe(403);
      expect((await pub('GET', `${s.token}/zip`)).statusCode).toBe(403);
      expect((await pub('GET', s.token)).json().allowDownload).toBe(false);
    });

    it('zip contains exactly the shared subtree with relative names', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      const res = await pub('GET', `${s.token}/zip`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain("filename*=UTF-8''A.zip");
      const entries = await unzip(res.rawPayload);
      expect(Object.fromEntries(entries)).toEqual({ 'a.txt': 'alpha', 'empty/': '', 'sub/': '', 'sub/x.txt': 'inside x' });
      const sub = await unzip((await pub('GET', `${s.token}/zip?folder=${t.sub.id}`)).rawPayload);
      expect(Object.fromEntries(sub)).toEqual({ 'x.txt': 'inside x' });
      // A file vanished on disk (not indexed yet) is skipped, the archive stays valid.
      await rename(path.join(userRoot(), 'P', 'A', 'a.txt'), path.join(userRoot(), 'gone.txt'));
      const after = await unzip((await pub('GET', `${s.token}/zip`)).rawPayload);
      expect([...after.keys()]).toEqual(['empty/', 'sub/', 'sub/x.txt']);
      const f = await share(t.a.id);
      expect((await pub('GET', `${f.token}/zip`)).statusCode).toBe(400);
    });

    it('serves thumbnails produced by the worker, 404 before', async () => {
      const t = await tree();
      const img = await upload(t.A.id, 'img.jpg', 'jpeg bytes');
      const s = await share(t.A.id);
      expect((await pub('GET', `${s.token}/items/${img.id}/thumbnail`)).statusCode).toBe(404);
      const sha = (await ctx.prisma.item.findUniqueOrThrow({ where: { id: img.id.slice(2) } })).contentHash!;
      const store = new DerivedStore(ctx.config.metaRoot);
      await store.writeAtomic(store.pathFor(sha, 'thumb', 256), Buffer.from('webp-256'));
      await ctx.prisma.derivativeJob.create({ data: { sha, kind: 'thumb', status: 'done' } });
      const res = await pub('GET', `${s.token}/items/${img.id}/thumbnail?size=256`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toBe('webp-256');
      expect((await pub('GET', `${s.token}/items/${img.id}/thumbnail?size=1024`)).statusCode).toBe(404);
      expect((await pub('GET', `${s.token}/items/${img.id}/thumbnail?size=999`)).statusCode).toBe(400);
      const listed = (await pub('GET', `${s.token}/items`)).json().find((e: { id: string }) => e.id === img.id);
      expect(listed.hasThumbnail).toBe(true);
    });

    it('external upload lands in the shared folder or a subfolder, renames on conflict, and is journaled', async () => {
      const t = await tree();
      const s = await share(t.A.id, { allowUpload: true });
      const c0 = (await api('GET', '/sync/v1/cursor')).json().cursor;
      const up = await pub('POST', `${s.token}/upload?name=a.txt`, { body: 'from outside' });
      expect(up.statusCode).toBe(201);
      expect(up.json()).toMatchObject({ name: 'a (2).txt', type: 'file', size: 12, mime: 'text/plain', hasThumbnail: false });
      const intoSub = await pub('POST', `${s.token}/upload?folder=${t.sub.id}&name=new.txt`, { body: 'n' });
      expect(intoSub.statusCode).toBe(201);
      expect((await pub('GET', `${s.token}/items?folder=${t.sub.id}`)).json().map((e: { name: string }) => e.name)).toEqual(['new.txt', 'x.txt']);
      const changes = (await api('GET', `/sync/v1/changes?cursor=${c0}`)).json().changes;
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: 'upsert', item: expect.objectContaining({ name: 'a (2).txt', parentId: t.A.id }) }),
        expect.objectContaining({ op: 'upsert', item: expect.objectContaining({ name: 'new.txt', parentId: t.sub.id }) }),
      ]));
      // Outside the share, invalid names, wrong content type.
      expect((await pub('POST', `${s.token}/upload?folder=${t.B.id}&name=evil.txt`, { body: 'x' })).statusCode).toBe(404);
      expect((await pub('POST', `${s.token}/upload?name=..`, { body: 'x' })).statusCode).toBe(400);
      expect((await pub('POST', `${s.token}/upload?name=${encodeURIComponent('../evil.txt')}`, { body: 'x' })).statusCode).toBe(400);
      const json = await pub('POST', `${s.token}/upload?name=j.txt`, { payload: { a: 1 } });
      expect(json.statusCode).toBe(400);
    });

    it('upload refused unless allowed; per-IP upload limit', async () => {
      const t = await tree();
      const s = await share(t.A.id);
      const res = await pub('POST', `${s.token}/upload?name=n.txt`, { body: 'x' });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('upload_not_allowed');
      const f = await share(t.a.id);
      expect((await pub('POST', `${f.token}/upload?name=n.txt`, { body: 'x' })).json().code).toBe('upload_not_allowed');

      const u = await share(t.A.id, { allowUpload: true });
      ctx.app.get(ShareRateLimits).upload = new RateLimiter({ capacity: 2, refillPerSec: 0.0001 });
      expect((await pub('POST', `${u.token}/upload?name=1.txt`, { body: '1' })).statusCode).toBe(201);
      expect((await pub('POST', `${u.token}/upload?name=2.txt`, { body: '2' })).statusCode).toBe(201);
      const limited = await pub('POST', `${u.token}/upload?name=3.txt`, { body: '3' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect((await pub('POST', `${u.token}/upload?name=3.txt`, { body: '3', ip: '198.51.100.8' })).statusCode).toBe(201);
    });

    it('a shared folder created on the host is shareable after indexing', async () => {
      await mkdir(path.join(userRoot(), 'Host'), { recursive: true });
      await writeFile(path.join(userRoot(), 'Host', 'h.txt'), 'host');
      await ctx.app.get(IndexerService).fullScan({ id: userId, username: 'jens' });
      const host = await ctx.prisma.item.findFirstOrThrow({ where: { name: 'Host' } });
      const s = await share(`d_${host.id}`);
      const [entry] = (await pub('GET', `${s.token}/items`)).json();
      expect((await pub('GET', `${s.token}/items/${entry.id}/content`)).body).toBe('host');
    });
  });
});
