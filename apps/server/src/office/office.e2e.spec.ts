import { JwtService } from '@nestjs/jwt';
import { readdir, readFile, rename, stat, writeFile, utimes } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createTestApp, createTestSpace, createTestUser, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import type { IndexSpace } from '../common/types';
import { VersionsService } from '../versions/versions.service';
import { conflictName, OfficeService, TEMPLATE_DIR } from './office.service';

const SECRET = 'office-test-secret-0123456789abcdef';
const PUBLIC = 'https://office.example.test';
const jwt = new JwtService({});
const sign = (payload: object, opts: { secret?: string; expiresIn?: number } = {}) =>
  jwt.sign(payload, { secret: opts.secret ?? SECRET, ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}) });

/** A tiny stand-in for the Document Server: serves the "edited" bytes and counts fetches. */
async function fakeServer() {
  const state = { body: Buffer.from('edited'), hits: [] as string[], redirectTo: '' };
  const server = http.createServer((req, res) => {
    state.hits.push(req.url ?? '');
    if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: state.redirectTo }); res.end(); return; }
    if (req.url?.startsWith('/hang')) return; // never answers
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': state.body.length });
    res.end(state.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, origin, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

describe('Office (Euro-Office) integration', () => {
  let ctx: TestContext; let token: string; let userId: string;
  let ds: Awaited<ReturnType<typeof fakeServer>>;
  let foreign: Awaited<ReturnType<typeof fakeServer>>;

  const api = (method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string>; body?: string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: url.startsWith('/api/') ? url : `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });
  const anon = (method: string, url: string, payload?: object, headers: Record<string, string> = {}) =>
    ctx.app.inject({ method: method as 'GET', url, headers, ...(payload ? { payload } : {}) });

  const upload = async (name: string, body: string, parentId = 'root') =>
    (await api('POST', `/items/upload?parentId=${parentId}&name=${encodeURIComponent(name)}`, { body })).json();
  const download = async (id: string) => (await api('GET', `/items/${id}/content`)).body;

  /** Opens an editor session; returns the config plus the Document-Server-side routes (path + query). */
  const open = async (id: string) => {
    const res = await api('GET', `/items/${id}/office?lang=de`);
    expect(res.statusCode).toBe(200);
    const cfg = res.json().config;
    const rel = (u: string) => { const x = new URL(u); return x.pathname + x.search; };
    return { cfg, key: cfg.document.key as string, contentPath: rel(cfg.document.url), callbackPath: rel(cfg.editorConfig.callbackUrl) };
  };
  const callback = (callbackPath: string, data: object, how: 'body' | 'header' = 'body') =>
    how === 'body'
      ? anon('POST', callbackPath, { ...data, token: sign(data) })
      : anon('POST', callbackPath, data, { authorization: `Bearer ${sign({ payload: data })}` });
  const saveData = (key: string, status = 2, url = `${PUBLIC}/cache/files/edited.docx?md5=x`) => ({ key, status, url, users: [userId] });

  async function start(overrides: Record<string, unknown> = {}) {
    ctx = await createTestApp({ officeUrl: PUBLIC, officeJwtSecret: SECRET, officeApiUrl: 'http://server:3000/api/', officeInternalUrl: ds.origin, ...overrides });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens J', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
  }

  beforeEach(async () => {
    ds = await fakeServer();
    foreign = await fakeServer();
  });
  afterEach(async () => {
    await ctx?.close();
    await ds.close();
    await foreign.close();
  });

  describe('enabled', () => {
    beforeEach(() => start());

    it('returns a signed editor config with short-lived file tokens', async () => {
      const item = await upload('Offer.docx', 'v1');
      const res = await api('GET', `/items/${item.id}/office?lang=de`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ documentServerUrl: PUBLIC, editable: true });
      const uuid = item.id.slice(2);
      const { token: cfgToken, ...cfg } = body.config;
      expect(cfg).toMatchObject({
        documentType: 'word',
        document: { fileType: 'docx', key: `${uuid}-1`, title: 'Offer.docx', permissions: { edit: true, download: true, print: true, comment: true } },
        editorConfig: { mode: 'edit', lang: 'de', user: { id: userId, name: 'Jens J' }, customization: { forcesave: true } },
      });
      expect(cfg.document.url).toMatch(new RegExp(`^http://server:3000/api/office/files/${item.id}/content\\?t=`));
      expect(cfg.editorConfig.callbackUrl).toMatch(new RegExp(`^http://server:3000/api/office/files/${item.id}/callback\\?t=`));
      // The whole config is signed with the shared secret.
      const verified = jwt.verify(cfgToken, { secret: SECRET });
      expect(verified).toMatchObject(cfg);
      expect(() => jwt.verify(cfgToken, { secret: 'other' })).toThrow();
      // File tokens: item, owner, purpose; 1 d for content, 7 d for the callback.
      const ct = jwt.verify(new URL(cfg.document.url).searchParams.get('t')!, { secret: SECRET });
      expect(ct).toMatchObject({ i: uuid, u: userId, p: 'content' });
      expect(ct.exp - ct.iat).toBe(86400);
      const cb = jwt.verify(new URL(cfg.editorConfig.callbackUrl).searchParams.get('t')!, { secret: SECRET });
      expect(cb).toMatchObject({ i: uuid, u: userId, p: 'callback' });
      expect(cb.exp - cb.iat).toBe(7 * 86400);
      expect((await api('GET', `/items/${item.id}/office`)).json().config.editorConfig.lang).toBe('en');
    });

    it('opens view-only formats read-only and rejects other files with 415', async () => {
      const pdf = await upload('scan.pdf', '%PDF');
      const res = (await api('GET', `/items/${pdf.id}/office`)).json();
      expect(res.editable).toBe(false);
      expect(res.config).toMatchObject({ documentType: 'pdf', document: { permissions: { edit: false, comment: false } }, editorConfig: { mode: 'view' } });
      const zip = await upload('a.zip', 'PK');
      const r = await api('GET', `/items/${zip.id}/office`);
      expect(r.statusCode).toBe(415);
      expect(r.json().code).toBe('invalid_request');
      const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'F' } })).json();
      expect((await api('GET', `/items/${folder.id}/office`)).statusCode).toBe(400);
      expect((await api('GET', `/items/f_00000000-0000-4000-8000-000000000000/office`)).statusCode).toBe(404);
      expect((await anon('GET', `/api/sync/v1/items/${zip.id}/office`)).statusCode).toBe(401);
    });

    it('content route serves the file only for a valid content token of that item', async () => {
      const item = await upload('Offer.docx', 'original');
      const other = await upload('Other.docx', 'other');
      const { contentPath, callbackPath } = await open(item.id);
      const ok = await anon('GET', contentPath);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('original');
      expect(ok.headers['content-disposition']).toBeUndefined();
      const uuid = item.id.slice(2);
      const t = (p: object, o?: { secret?: string; expiresIn?: number }) => `/api/office/files/${item.id}/content?t=${sign(p, o)}`;
      // wrong purpose (the callback token), expired, other item, foreign secret, none
      expect((await anon('GET', `/api/office/files/${item.id}/content?${new URL(callbackPath, 'http://x').searchParams}`)).statusCode).toBe(403);
      expect((await anon('GET', t({ i: uuid, u: userId, p: 'content', exp: Math.floor(Date.now() / 1000) - 10 }))).statusCode).toBe(403);
      expect((await anon('GET', t({ i: other.id.slice(2), u: userId, p: 'content' }))).statusCode).toBe(403);
      expect((await anon('GET', `/api/office/files/${other.id}/content?${new URL(contentPath, 'http://x').searchParams}`)).statusCode).toBe(403);
      expect((await anon('GET', t({ i: uuid, u: userId, p: 'content' }, { secret: 'nope' }))).statusCode).toBe(403);
      expect((await anon('GET', `/api/office/files/${item.id}/content`)).statusCode).toBe(403);
      // A token naming another owner does not reach this user's file.
      expect((await anon('GET', t({ i: uuid, u: '00000000-0000-4000-8000-000000000000', p: 'content' }))).statusCode).toBe(404);
      // Trashed: gone.
      await api('DELETE', `/items/${item.id}`);
      expect((await anon('GET', contentPath)).statusCode).toBe(404);
    });

    it('rejects callbacks without a valid Document Server signature or file token, writing nothing', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      const data = saveData(key);
      const tries = [
        anon('POST', callbackPath, data), // unsigned
        anon('POST', callbackPath, { ...data, token: sign(data, { secret: 'wrong' }) }),
        anon('POST', callbackPath, data, { authorization: `Bearer ${sign({ payload: data }, { secret: 'wrong' })}` }),
        anon('POST', callbackPath.replace(/\?t=.*/, ''), { ...data, token: sign(data) }), // no file token
        anon('POST', `/api/office/files/${item.id}/callback?t=${sign({ i: item.id.slice(2), u: userId, p: 'content' })}`, { ...data, token: sign(data) }),
        // a signed body for another document's session
        callback(callbackPath, saveData(`00000000-0000-4000-8000-000000000000-1`)),
      ];
      for (const r of await Promise.all(tries)) expect(r.statusCode).toBe(403);
      // Valid callback token of another file.
      const other = await upload('Other.docx', 'other');
      const { callbackPath: otherCb } = await open(other.id);
      expect((await callback(otherCb.replace(other.id, item.id), data)).statusCode).toBe(403);
      expect(ds.state.hits).toEqual([]);
      expect(await download(item.id)).toBe('original');
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(1);
    });

    it('never fetches from a foreign origin', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      for (const url of [`${foreign.origin}/cache/x`, `${PUBLIC}//evil.example:8080/x`, `${PUBLIC}/\\evil.example/x`, `${PUBLIC}//${new URL(foreign.origin).host}/cache/x`, `${PUBLIC}/\\${new URL(foreign.origin).host}/cache/x`, `${ds.origin}//${new URL(foreign.origin).host}/x`, 'file:///etc/passwd', 'not a url', `https://office.example.test.evil.com/x`, `http://user:pw@${new URL(ds.origin).host}/x`]) {
        const r = await callback(callbackPath, saveData(key, 2, url));
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({ error: 1 });
      }
      expect(foreign.state.hits).toEqual([]);
      expect(ds.state.hits).toEqual([]);
      expect(await download(item.id)).toBe('original');
    });

    it('refuses redirects and gives up on a download that does not finish', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      ds.state.redirectTo = `${foreign.origin}/cache/x`;
      expect((await callback(callbackPath, saveData(key, 2, `${PUBLIC}/redirect/x`))).json()).toEqual({ error: 1 });
      expect(ds.state.hits).toEqual(['/redirect/x']);
      expect(foreign.state.hits).toEqual([]);
      const saved = OfficeService.downloadTimeoutMs;
      OfficeService.downloadTimeoutMs = 300;
      try {
        expect((await callback(callbackPath, saveData(key, 2, `${PUBLIC}/hang/x`))).json()).toEqual({ error: 1 });
      } finally {
        OfficeService.downloadTimeoutMs = saved;
      }
      expect(await download(item.id)).toBe('original');
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(1);
    });

    it('accepts an expired callback token when the Document Server signed the save', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      const uuid = item.id.slice(2);
      const iat = Math.floor(Date.now() / 1000) - 8 * 86400;
      const old = sign({ i: uuid, u: userId, p: 'callback', iat, exp: iat + 7 * 86400 });
      const oldPath = `/api/office/files/${item.id}/callback?t=${old}`;
      // Still bound: wrong purpose, other item, foreign secret, unsigned body.
      const oldContent = sign({ i: uuid, u: userId, p: 'content', iat, exp: iat + 86400 });
      expect((await callback(`/api/office/files/${item.id}/callback?t=${oldContent}`, saveData(key, 2))).statusCode).toBe(403);
      expect((await callback(oldPath.replace(item.id, `f_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`), saveData(key, 2))).statusCode).toBe(403);
      expect((await callback(`/api/office/files/${item.id}/callback?t=${sign({ i: uuid, u: userId, p: 'callback', iat, exp: iat + 1 }, { secret: 'nope' })}`, saveData(key, 2))).statusCode).toBe(403);
      expect((await anon('POST', oldPath, saveData(key, 2))).statusCode).toBe(403);
      expect(ds.state.hits).toEqual([]);
      expect(callbackPath).not.toBe(oldPath);
      expect((await callback(oldPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('edited');
      // Content tokens stay strictly time-limited.
      expect((await anon('GET', `/api/office/files/${item.id}/content?t=${oldContent}`)).statusCode).toBe(403);
    });

    it('status 2 replaces the content (version + 1, officeKey, journal, version capture)', async () => {
      const capture = jest.spyOn(ctx.app.get(VersionsService), 'capture');
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      const cursor = (await api('GET', '/cursor')).json().cursor;
      ds.state.body = Buffer.from('edited in office');
      const r = await callback(callbackPath, saveData(key, 2));
      expect(r.json()).toEqual({ error: 0 });
      // The public URL was rewritten to the internal origin.
      expect(ds.state.hits).toEqual(['/cache/files/edited.docx?md5=x']);
      expect(await download(item.id)).toBe('edited in office');
      const row = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id.slice(2) } });
      expect(row).toMatchObject({ version: 2, officeKey: key, size: 16n });
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const changes = (await api('GET', `/changes?cursor=${cursor}`)).json().changes;
      expect(changes).toEqual([expect.objectContaining({ op: 'upsert', item: expect.objectContaining({ id: item.id, version: 2 }) })]);
      expect(capture).toHaveBeenCalledTimes(1);
      const [, user, captured, abs, source, by] = capture.mock.calls[0];
      expect(user.id).toBe(userId);
      expect(captured).toMatchObject({ id: item.id.slice(2), version: 1 });
      expect(abs).toBe(path.join(ctx.config.dataRoot, 'jens', 'Offer.docx'));
      expect(source).toBe('office');
      expect(by).toBe(userId);
      // Nothing else appeared in the folder.
      expect((await api('GET', '/items/root/children')).json().items.map((i: { name: string }) => i.name)).toEqual(['Offer.docx']);
    });

    it('accepts the Authorization header variant of the signature', async () => {
      const item = await upload('Sheet.xlsx', 'original');
      const { key, callbackPath } = await open(item.id);
      expect((await callback(callbackPath, saveData(key, 2), 'header')).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('edited');
    });

    it('ignores statuses other than 2 and 6', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      for (const status of [1, 3, 4, 7]) expect((await callback(callbackPath, saveData(key, status))).json()).toEqual({ error: 0 });
      expect(ds.state.hits).toEqual([]);
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(1);
    });

    it('a stale session (file changed by a sync client) writes a conflict copy and keeps the original', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      expect((await api('PUT', `/items/${item.id}/content`, { body: 'from sync', headers: { 'if-match': '"v1"' } })).json().version).toBe(2);
      ds.state.body = Buffer.from('office edit');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('from sync');
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(2);
      const items = (await api('GET', '/items/root/children')).json().items as { id: string; name: string }[];
      expect(items).toHaveLength(2);
      const copy = items.find((i) => i.id !== item.id)!;
      expect(copy.name).toMatch(/^Offer \(Konflikt Office \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.docx$/);
      expect(await download(copy.id)).toBe('office edit');
      // A second save of the same stale session gets another copy, never the original.
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('from sync');
      expect((await api('GET', '/items/root/children')).json().items).toHaveLength(3);
    });

    it('a sync edit after a forcesave of the session still leads to a conflict copy', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      expect((await callback(callbackPath, saveData(key, 6))).json()).toEqual({ error: 0 });
      expect((await api('PUT', `/items/${item.id}/content`, { body: 'from sync', headers: { 'if-match': '"v2"' } })).json().version).toBe(3);
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('from sync');
      expect((await api('GET', '/items/root/children')).json().items).toHaveLength(2);
    });

    it('an unindexed host edit leads to a conflict copy as well', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      const abs = path.join(ctx.config.dataRoot, 'jens', 'Offer.docx');
      await writeFile(abs, 'host edit!');
      await utimes(abs, new Date(), new Date(Date.now() + 5000));
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await readFile(abs, 'utf8')).toBe('host edit!');
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(2);
      expect((await api('GET', '/items/root/children')).json().items).toHaveLength(2);
    });

    it('repeated forcesaves of one session overwrite each other without conflict copies', async () => {
      const capture = jest.spyOn(ctx.app.get(VersionsService), 'capture');
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      ds.state.body = Buffer.from('save 1');
      expect((await callback(callbackPath, saveData(key, 6))).json()).toEqual({ error: 0 });
      ds.state.body = Buffer.from('save 2');
      expect((await callback(callbackPath, saveData(key, 6))).json()).toEqual({ error: 0 });
      ds.state.body = Buffer.from('final');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('final');
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(4);
      expect((await api('GET', '/items/root/children')).json().items).toHaveLength(1);
      expect(capture.mock.calls.map((c) => c[4])).toEqual(['office', 'office', 'office']);
      // The next session starts on the new version.
      expect((await open(item.id)).key).toBe(`${item.id.slice(2)}-4`);
    });

    it('saves the edits of a file trashed while editing as a conflict copy in its folder', async () => {
      const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Docs' } })).json();
      const item = await upload('Offer.docx', 'original', folder.id);
      const { key, callbackPath } = await open(item.id);
      expect((await api('DELETE', `/items/${item.id}`)).statusCode).toBe(204);
      ds.state.body = Buffer.from('edits made while it was trashed');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      const items = (await api('GET', `/items/${folder.id}/children`)).json().items as { id: string; name: string }[];
      expect(items).toHaveLength(1);
      expect(items[0].id).not.toBe(item.id);
      expect(items[0].name).toMatch(/^Offer \(Konflikt Office \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.docx$/);
      expect(await download(items[0].id)).toBe('edits made while it was trashed');
      // The trashed original is untouched (still in the trash with its old content).
      const trash = (await api('GET', '/api/trash')).json();
      expect(JSON.stringify(trash)).toContain('Offer.docx');
      expect((await api('GET', '/items/root/children')).json().items.map((i: { name: string }) => i.name)).toEqual(['Docs']);
    });

    it('puts the conflict copy into the user root when the original folder is gone as well', async () => {
      const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Docs' } })).json();
      const item = await upload('Offer.docx', 'original', folder.id);
      const { key, callbackPath } = await open(item.id);
      expect((await api('DELETE', `/items/${folder.id}`)).statusCode).toBe(204);
      ds.state.body = Buffer.from('rescued');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      const items = (await api('GET', '/items/root/children')).json().items as { id: string; name: string }[];
      expect(items).toHaveLength(1);
      expect(items[0].name).toMatch(/^Offer \(Konflikt Office .+\)\.docx$/);
      expect(await download(items[0].id)).toBe('rescued');
    });

    it('asks the Document Server to retry while the file is briefly missing on disk', async () => {
      const item = await upload('Offer.docx', 'original');
      const { key, callbackPath } = await open(item.id);
      const abs = path.join(ctx.config.dataRoot, 'jens', 'Offer.docx');
      const moved = `${abs}.moved-away`;
      await rename(abs, moved); // e.g. the middle of a host editor's delete + rename save
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 1 });
      expect((await readdir(path.join(ctx.config.dataRoot, 'jens'))).sort()).toEqual(['Offer.docx.moved-away']);
      const row = await ctx.prisma.item.findUniqueOrThrow({ where: { id: item.id.slice(2) } });
      expect(row).toMatchObject({ version: 1, deletedAt: null, officeKey: null });
      // Back in place: the retried save goes through.
      await rename(moved, abs);
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await download(item.id)).toBe('edited');
    });

    it('keeps a path prefix of the internal Document Server URL', async () => {
      await ctx.close();
      await start({ officeInternalUrl: `${ds.origin}/ds/` });
      const item = await upload('Offer.docx', 'abc');
      const { key, callbackPath } = await open(item.id);
      expect((await callback(callbackPath, saveData(key, 6, `${PUBLIC}/cache/a?b=1`))).json()).toEqual({ error: 0 });
      expect((await callback(callbackPath, saveData(key, 6, `${ds.origin}/ds/cache/c`))).json()).toEqual({ error: 0 });
      expect(ds.state.hits).toEqual(['/ds/cache/a?b=1', '/ds/cache/c']);
    });

    it('answers {error:1} when the download fails or is too large', async () => {
      await ctx.close();
      await start({ maxUploadBytes: 4 });
      const item = await upload('Offer.docx', 'abc');
      const { key, callbackPath } = await open(item.id);
      ds.state.body = Buffer.from('too large');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 1 });
      expect(await download(item.id)).toBe('abc');
      expect((await api('GET', `/items/${item.id}`)).json().version).toBe(1);
    });

    it('creates new documents from templates, renaming on conflict', async () => {
      const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Docs' } })).json();
      for (const format of ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv']) {
        const res = await api('POST', '/items/new-office', { payload: { parentId: folder.id, name: 'Report', format } });
        expect(res.statusCode).toBe(201);
        const tpl = await readFile(path.join(TEMPLATE_DIR, `new.${format}`));
        expect(res.json()).toMatchObject({ name: `Report.${format}`, parentId: folder.id, size: tpl.length, version: 1 });
        expect(Buffer.from((await api('GET', `/items/${res.json().id}/content`)).rawPayload).equals(tpl)).toBe(true);
      }
      const again = await api('POST', '/items/new-office', { payload: { parentId: folder.id, name: 'report.docx', format: 'docx' } });
      expect(again.statusCode).toBe(201);
      expect(again.json().name).toBe('report (2).docx');
      const atRoot = await api('POST', '/items/new-office', { payload: { parentId: 'root', name: ' Notes ', format: 'txt' } });
      expect(atRoot.json()).toMatchObject({ name: 'Notes.txt', parentId: 'root' });
      expect((await api('POST', '/items/new-office', { payload: { parentId: 'root', name: 'x', format: 'exe' } })).statusCode).toBe(400);
      expect((await api('POST', '/items/new-office', { payload: { parentId: 'root', name: '  ', format: 'docx' } })).statusCode).toBe(400);
      expect((await api('POST', '/items/new-office', { payload: { parentId: 'root', name: 'a/b', format: 'docx' } })).statusCode).toBe(400);
      expect((await api('POST', '/items/new-office', { payload: { parentId: atRoot.json().id, name: 'x', format: 'docx' } })).statusCode).toBe(400);
    });
  });

  describe('in team spaces', () => {
    let team: IndexSpace; let carolId: string; let carol: string;
    const as = (t: string, url: string) => ctx.app.inject({ method: 'GET', url: `/api/sync/v1${url}`, headers: { authorization: `Bearer ${t}` } });
    beforeEach(async () => {
      await start();
      team = await createTestSpace(ctx, 'Team');
      const c = await createTestUser(ctx, 'carol');
      carolId = c.id;
      carol = await ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.id } }));
      await ctx.prisma.spaceMember.createMany({ data: [{ spaceId: team.id, userId, role: 'write' }, { spaceId: team.id, userId: c.id, role: 'read' }] });
    });

    it('write members edit: tokens carry space and editor; the callback writes into the team folder on disk', async () => {
      const folder = (await api('POST', '/items', { payload: { parentId: `r_${team.id}`, type: 'folder', name: 'Docs' } })).json();
      const item = await upload('Plan.docx', 'original', folder.id);
      const res = (await api('GET', `/items/${item.id}/office`)).json();
      expect(res).toMatchObject({ editable: true, config: { editorConfig: { mode: 'edit' } } });
      const { key, contentPath, callbackPath } = await open(item.id);
      const ct = jwt.verify(new URL(contentPath, 'http://x').searchParams.get('t')!, { secret: SECRET });
      expect(ct).toMatchObject({ i: item.id.slice(2), s: team.id, u: userId, p: 'content' });
      expect((await anon('GET', contentPath)).body).toBe('original');
      ds.state.body = Buffer.from('team edit');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await readFile(path.join(team.rootPath, 'Docs', 'Plan.docx'), 'utf8')).toBe('team edit');
      expect(await readdir(path.join(ctx.config.dataRoot, 'jens'))).toEqual([]);
      expect((await as(carol, `/items/${item.id}/content`)).body).toBe('team edit');
    });

    it('read members get a view-only session in its own key; its callback writes nothing', async () => {
      const item = await upload('Plan.docx', 'original', `r_${team.id}`);
      const res = await as(carol, `/items/${item.id}/office`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ editable: false, config: { document: { permissions: { edit: false, comment: false } }, editorConfig: { mode: 'view', user: { id: carolId } } } });
      const editKey = (await open(item.id)).key;
      expect(body.config.document.key).not.toBe(editKey);
      const rel = (u: string) => { const x = new URL(u); return x.pathname + x.search; };
      expect((await anon('GET', rel(body.config.document.url))).body).toBe('original');
      const cb = await callback(rel(body.config.editorConfig.callbackUrl), { ...saveData(body.config.document.key, 2), users: [carolId] });
      expect(cb.statusCode).toBe(403);
      // even with the edit session's key, a view token never writes
      expect((await callback(rel(body.config.editorConfig.callbackUrl), saveData(editKey, 2))).statusCode).toBe(403);
      expect(ds.state.hits).toEqual([]);
      expect(await readFile(path.join(team.rootPath, 'Plan.docx'), 'utf8')).toBe('original');
      // outsiders: 404; read members cannot create documents (403)
      const eve = await createTestUser(ctx, 'eve');
      const eveT = await ctx.app.get(AuthService).signAccess(await ctx.prisma.user.findUniqueOrThrow({ where: { id: eve.id } }));
      expect((await as(eveT, `/items/${item.id}/office`)).statusCode).toBe(404);
      const created = await ctx.app.inject({ method: 'POST', url: '/api/sync/v1/items/new-office', headers: { authorization: `Bearer ${carol}` }, payload: { parentId: `r_${team.id}`, name: 'X', format: 'docx' } });
      expect(created.statusCode).toBe(403);
    });

    it('creates new documents in a team folder', async () => {
      const res = await api('POST', '/items/new-office', { payload: { parentId: `r_${team.id}`, name: 'Report', format: 'docx' } });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'Report.docx', parentId: `r_${team.id}`, spaceId: team.id });
      expect((await stat(path.join(team.rootPath, 'Report.docx'))).isFile()).toBe(true);
    });

    it('drops the save and stops serving content when the editor lost write access', async () => {
      const item = await upload('Plan.docx', 'original', `r_${team.id}`);
      const { key, contentPath, callbackPath } = await open(item.id);
      await ctx.prisma.spaceMember.updateMany({ where: { spaceId: team.id, userId }, data: { role: 'read' } });
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(ds.state.hits).toEqual([]);
      expect(await readFile(path.join(team.rootPath, 'Plan.docx'), 'utf8')).toBe('original');
      await ctx.prisma.spaceMember.deleteMany({ where: { spaceId: team.id, userId } });
      expect((await anon('GET', contentPath)).statusCode).toBe(404);
    });

    it('a file moved to another space while editing is saved where it now is', async () => {
      const item = await upload('Plan.docx', 'original', `r_${team.id}`);
      const { key, callbackPath } = await open(item.id);
      expect((await api('PATCH', `/items/${item.id}`, { payload: { parentId: 'root' } })).statusCode).toBe(200);
      ds.state.body = Buffer.from('moved edit');
      expect((await callback(callbackPath, saveData(key, 2))).json()).toEqual({ error: 0 });
      expect(await readFile(path.join(ctx.config.dataRoot, 'jens', 'Plan.docx'), 'utf8')).toBe('moved edit');
      expect(await readdir(team.rootPath)).toEqual([]);
    });
  });

  describe('disabled', () => {
    beforeEach(() => start({ officeUrl: null, officeJwtSecret: null }));

    it('answers 503 office_disabled on every office route but still creates new documents', async () => {
      const item = await upload('Offer.docx', 'original');
      const config = await api('GET', `/items/${item.id}/office`);
      expect(config.statusCode).toBe(503);
      expect(config.json().code).toBe('office_disabled');
      const t = sign({ i: item.id.slice(2), u: userId, p: 'content' });
      expect((await anon('GET', `/api/office/files/${item.id}/content?t=${t}`)).json().code).toBe('office_disabled');
      const cb = sign({ i: item.id.slice(2), u: userId, p: 'callback' });
      const data = saveData(`${item.id.slice(2)}-1`);
      const r = await anon('POST', `/api/office/files/${item.id}/callback?t=${cb}`, { ...data, token: sign(data) });
      expect(r.statusCode).toBe(503);
      expect(ds.state.hits).toEqual([]);
      expect(await download(item.id)).toBe('original');
      const created = await api('POST', '/items/new-office', { payload: { parentId: 'root', name: 'New', format: 'docx' } });
      expect(created.statusCode).toBe(201);
      expect(created.json().size).toBe((await stat(path.join(TEMPLATE_DIR, 'new.docx'))).size);
    });

    it('half a configuration is disabled too', async () => {
      await ctx.close();
      await start({ officeJwtSecret: null });
      const item = await upload('Offer.docx', 'x');
      expect((await api('GET', `/items/${item.id}/office`)).statusCode).toBe(503);
    });
  });
});

describe('conflictName', () => {
  it('formats the conflict pattern in local time and keeps names short', () => {
    expect(conflictName('Offer.docx', new Date(2026, 9, 4, 9, 30))).toBe('Offer (Konflikt Office 2026-10-04 09-30).docx');
    expect(conflictName('README', new Date(2026, 0, 1, 0, 5))).toBe('README (Konflikt Office 2026-01-01 00-05)');
    const long = conflictName(`${'ä'.repeat(200)}.xlsx`, new Date(2026, 0, 1));
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(240);
    expect(long).toMatch(/^ä+ \(Konflikt Office 2026-01-01 00-00\)\.xlsx$/);
  });
});
