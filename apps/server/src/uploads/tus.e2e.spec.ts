import fsp from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';
import { FilesService } from '../files/files.service';
import { SchedulerService } from '../indexer/scheduler.service';
import { TUS_PATH } from './tus';

// Above Fastify's default bodyLimit (1 MiB): tus bodies must be streamed, never buffered.
const MAX = 5_000_000;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const metadata = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(',');

interface RawResponse { statusCode: number; headers: Record<string, string>; body: string; json(): any }

/**
 * tus runs on the raw Node request/response (reply.hijack), so these tests talk real HTTP to a
 * listening server: light-my-request's fake response does not support `res.end(callback)`.
 */
describe('tus uploads', () => {
  let ctx: TestContext; let token: string; let userId: string; let base: string;
  const userDir = () => path.join(ctx.config.dataRoot, 'jens');
  const stagingDir = () => path.join(ctx.config.metaRoot, 'uploads');

  const tus = async (method: string, url: string, headers: Record<string, string> = {}, body?: Buffer): Promise<RawResponse> => {
    const all: Record<string, string> = { 'tus-resumable': '1.0.0', authorization: `Bearer ${token}`, ...headers };
    for (const k of Object.keys(all)) if (all[k] === '') delete all[k];
    const res = await fetch(`${base}${url}`, { method, headers: all, ...(body !== undefined ? { body: new Uint8Array(body) } : {}) });
    const text = await res.text();
    return { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body: text, json: () => JSON.parse(text) };
  };
  const create = (length: number, m: Record<string, string>, headers: Record<string, string> = {}) =>
    tus('POST', TUS_PATH, { 'upload-length': String(length), 'upload-metadata': metadata(m), ...headers });
  const patch = (location: string, offset: number, chunk: Buffer, headers: Record<string, string> = {}) =>
    tus('PATCH', location, { 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream', ...headers }, chunk);

  beforeEach(async () => {
    ctx = await createTestApp({ maxUploadBytes: MAX });
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
    await ctx.app.listen(0, '127.0.0.1');
    base = (await ctx.app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterEach(async () => { jest.restoreAllMocks(); await ctx.close(); });

  it('resumes an interrupted upload from the server offset; nothing reaches /data before completion', async () => {
    const data = randomBytes(3_000_000);
    const cut = 1_800_000; // 60 %
    const created = await create(data.length, { name: 'video.bin', modifiedAt: '2024-05-06T07:08:09.000Z' }, {
      // Caddy-style forwarding headers must not leak an internal host into Location.
      'x-forwarded-host': 'files.example.org', 'x-forwarded-proto': 'https',
    });
    expect(created.statusCode).toBe(201);
    const location = created.headers.location;
    expect(location).toMatch(new RegExp(`^${TUS_PATH}/${userId}-[0-9a-f]{32}$`));
    expect(created.headers['access-control-allow-origin']).toBeUndefined();

    const first = await patch(location, 0, data.subarray(0, cut));
    expect(first.statusCode).toBe(204);
    expect(first.headers['upload-offset']).toBe(String(cut));
    // Interrupted at 60 %: the user folder is untouched, the part lives in /meta/uploads.
    expect(await readdir(userDir())).toEqual([]);
    expect((await readdir(stagingDir())).sort()).toEqual([path.basename(location), `${path.basename(location)}.json`]);

    const head = await tus('HEAD', location);
    expect(head.statusCode).toBe(200);
    expect(head.headers['upload-offset']).toBe(String(cut));
    expect(head.headers['upload-length']).toBe(String(data.length));
    expect(head.headers['cache-control']).toBe('no-store');

    const rest = await patch(location, Number(head.headers['upload-offset']), data.subarray(cut));
    expect(rest.statusCode).toBe(200);
    expect(rest.headers['upload-offset']).toBe(String(data.length));
    const item = rest.json();
    expect(item).toMatchObject({
      kind: 'file', name: 'video.bin', parentId: 'root', size: data.length, version: 1,
      sha256: createHash('sha256').update(data).digest('hex'), modifiedAt: '2024-05-06T07:08:09.000Z',
    });
    expect(rest.headers['x-synclet-item']).toBe(item.id);
    expect((await readFile(path.join(userDir(), 'video.bin'))).equals(data)).toBe(true);
    // Only the final file in /data (no temp leftovers); the staged part and its metadata are gone.
    expect(await readdir(userDir())).toEqual(['video.bin']);
    expect(await readdir(stagingDir())).toEqual([]);
    expect((await tus('HEAD', location)).statusCode).toBe(404);
    const viaApi = await ctx.app.inject({ method: 'GET', url: `/api/sync/v1/items/${item.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(viaApi.json()).toMatchObject({ id: item.id, size: data.length });
  });

  it('keeps what arrived before the connection dropped and resumes from there', async () => {
    const data = randomBytes(400_000);
    const location = (await create(data.length, { name: 'dropped.bin' })).headers.location;
    // Send 60 % of a PATCH that announces the whole body, then kill the connection.
    await new Promise<void>((resolve) => {
      const req = http.request(`${base}${location}`, {
        method: 'PATCH',
        headers: {
          'tus-resumable': '1.0.0', authorization: `Bearer ${token}`, 'upload-offset': '0',
          'content-type': 'application/offset+octet-stream', 'content-length': String(data.length),
        },
      });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(data.subarray(0, 240_000), () => setTimeout(() => req.destroy(), 200));
    });
    expect(await readdir(userDir())).toEqual([]);
    let offset = -1;
    for (let i = 0; i < 50; i++) { // the server notices the abort asynchronously
      const head = await tus('HEAD', location);
      offset = Number(head.headers['upload-offset']);
      if (head.statusCode === 200 && offset === 240_000) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(offset).toBe(240_000);
    const rest = await patch(location, offset, data.subarray(offset));
    expect(rest.statusCode).toBe(200);
    expect((await readFile(path.join(userDir(), 'dropped.bin'))).equals(data)).toBe(true);
    expect(await readdir(userDir())).toEqual(['dropped.bin']);
    expect(await readdir(stagingDir())).toEqual([]);
  });

  it('rejects a wrong Upload-Offset with 409 without touching the upload', async () => {
    const location = (await create(10, { name: 'a.txt' })).headers.location;
    expect((await patch(location, 0, Buffer.from('12345'))).statusCode).toBe(204);
    expect((await patch(location, 3, Buffer.from('xx'))).statusCode).toBe(409);
    expect((await patch(location, 0, Buffer.from('xx'))).statusCode).toBe(409);
    expect((await tus('HEAD', location)).headers['upload-offset']).toBe('5');
  });

  it("hides other users' uploads (404) and requires authentication (401)", async () => {
    const location = (await create(10, { name: 'a.txt' })).headers.location;
    await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${token}` },
      payload: { username: 'bob', displayName: 'Bob', password: 'bob password 123' },
    });
    const bobToken = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'bob', password: 'bob password 123' } })).json().accessToken;
    expect(bobToken).toBeTruthy();
    const asBob = { authorization: `Bearer ${bobToken}` };
    expect((await tus('HEAD', location, asBob)).statusCode).toBe(404);
    expect((await patch(location, 0, Buffer.from('evil'), asBob)).statusCode).toBe(404);
    expect((await tus('DELETE', location, asBob)).statusCode).toBe(404);

    const anon = { authorization: '' };
    const post = await create(10, { name: 'b.txt' }, anon);
    expect(post.statusCode).toBe(401);
    expect(post.json().code).toBe('unauthorized');
    expect((await tus('HEAD', location, anon)).statusCode).toBe(401);
    expect((await patch(location, 0, Buffer.from('x'), anon)).statusCode).toBe(401);
    expect((await tus('DELETE', location, { authorization: 'Bearer syd_bogus' })).statusCode).toBe(401);
    // The owner's upload is untouched.
    expect((await tus('HEAD', location)).headers['upload-offset']).toBe('0');
  });

  it('accepts device tokens', async () => {
    const device = (await ctx.app.inject({
      method: 'POST', url: '/api/sync/v1/devices', headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Mac', platform: 'macos', appVersion: '1.0' },
    })).json().token as string;
    const created = await create(2, { name: 'd.txt' }, { authorization: `Bearer ${device}` });
    expect(created.statusCode).toBe(201);
    const done = await patch(created.headers.location, 0, Buffer.from('hi'), { authorization: `Bearer ${device}` });
    expect(done.json()).toMatchObject({ name: 'd.txt', size: 2 });
  });

  it('enforces the size limit (413) and advertises Tus-Max-Size', async () => {
    const over = await create(MAX + 1, { name: 'big.bin' });
    expect(over.statusCode).toBe(413);
    expect(await readdir(stagingDir())).toEqual([]);
    const options = await tus('OPTIONS', TUS_PATH, { authorization: '', 'tus-resumable': '' });
    expect(options.statusCode).toBe(204);
    expect(options.headers['tus-max-size']).toBe(String(MAX));
    expect(options.headers['tus-version']).toBe('1.0.0');
  });

  it('validates metadata at creation', async () => {
    const noName = await tus('POST', TUS_PATH, { 'upload-length': '1', 'upload-metadata': metadata({ parentId: 'root' }) });
    expect(noName.statusCode).toBe(400);
    expect(JSON.parse(noName.body).code).toBe('invalid_name');
    for (const name of ['a/b.txt', 'trailing.', '.DS_Store', 'con']) {
      const res = await create(1, { name });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe('invalid_name');
    }
    const missingParent = await create(1, { name: 'x.txt', parentId: 'd_3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab' });
    expect(missingParent.statusCode).toBe(404);
    expect(JSON.parse(missingParent.body).code).toBe('not_found');
    expect((await create(1, { name: 'x.txt', parentId: 'bogus' })).statusCode).toBe(400);
    expect((await create(1, { name: 'x.txt', onConflict: 'replace' })).statusCode).toBe(400);
    expect((await create(1, { name: 'x.txt', modifiedAt: 'yesterday' })).statusCode).toBe(400);
    expect(await readdir(stagingDir())).toEqual([]);
  });

  it('uploads into a folder; name conflicts rename by default, onConflict=fail answers 409 and drops the part', async () => {
    const api = (method: string, url: string, payload?: object, body?: string) => ctx.app.inject({
      method: method as 'POST', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/octet-stream' } : {}) },
      ...(body !== undefined ? { body } : payload ? { payload } : {}),
    });
    const folder = (await api('POST', '/items', { parentId: 'root', type: 'folder', name: 'Docs' })).json();
    await api('POST', `/items/upload?parentId=${folder.id}&name=a.txt`, undefined, 'one');

    const loc = (await create(3, { name: 'A.TXT', parentId: folder.id })).headers.location;
    const renamed = await patch(loc, 0, Buffer.from('two'));
    expect(renamed.json()).toMatchObject({ name: 'A (2).TXT', parentId: folder.id });

    const failLoc = (await create(5, { name: 'a.txt', parentId: folder.id, onConflict: 'fail' })).headers.location;
    const conflict = await patch(failLoc, 0, Buffer.from('three'));
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({ code: 'name_conflict', item: { name: 'a.txt' } });
    expect(await readdir(stagingDir())).toEqual([]);
    expect((await readdir(path.join(userDir(), 'Docs'))).sort()).toEqual(['A (2).TXT', 'a.txt']);
    expect(await readFile(path.join(userDir(), 'Docs', 'a.txt'), 'utf8')).toBe('one');
  });

  it('completes in the creation request (creation-with-upload) and handles empty files', async () => {
    const one = await create(5, { name: 'one.txt' }, { 'content-type': 'application/offset+octet-stream' });
    expect(one.statusCode).toBe(201); // body was not sent yet: plain create
    const withBody = await tus('POST', TUS_PATH, {
      'upload-length': '5', 'upload-metadata': metadata({ name: 'inline.txt' }), 'content-type': 'application/offset+octet-stream',
    }, Buffer.from('hello'));
    expect(withBody.statusCode).toBe(201);
    expect(withBody.headers.location).toMatch(new RegExp(`^${TUS_PATH}/`));
    expect(withBody.json()).toMatchObject({ name: 'inline.txt', size: 5 });
    const empty = await create(0, { name: 'empty.txt' });
    expect(empty.statusCode).toBe(201);
    expect(empty.json()).toMatchObject({ name: 'empty.txt', size: 0 });
    expect((await readdir(userDir())).sort()).toEqual(['empty.txt', 'inline.txt']);
    expect(await readFile(path.join(userDir(), 'inline.txt'), 'utf8')).toBe('hello');
  });

  it('refuses PATCH/DELETE (423) while an upload is being published, so it is published once', async () => {
    const location = (await create(4, { name: 'once.txt' })).headers.location;
    const files = ctx.app.get(FilesService);
    const real = files.upload.bind(files);
    let entered!: () => void; let release!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    jest.spyOn(files, 'upload').mockImplementation(async (...args) => { entered(); await gate; return real(...args); });
    const final = patch(location, 0, Buffer.from('data'));
    await inside;
    expect((await patch(location, 4, Buffer.alloc(0))).statusCode).toBe(423);
    expect((await tus('DELETE', location)).statusCode).toBe(423);
    release();
    expect((await final).statusCode).toBe(200);
    expect(files.upload).toHaveBeenCalledTimes(1);
    expect(await readdir(userDir())).toEqual(['once.txt']);
    expect(await readdir(stagingDir())).toEqual([]);
  });

  it('DELETE terminates an upload and removes its staged files', async () => {
    const location = (await create(10, { name: 'a.txt' })).headers.location;
    await patch(location, 0, Buffer.from('1234'));
    expect((await readdir(stagingDir())).length).toBe(2);
    expect((await tus('DELETE', location)).statusCode).toBe(204);
    expect(await readdir(stagingDir())).toEqual([]);
    expect((await tus('HEAD', location)).statusCode).toBe(404);
    expect(await readdir(userDir())).toEqual([]);
  });

  it('maintenance removes uploads abandoned for more than 24 h and keeps fresh ones', async () => {
    const stale = path.basename((await create(10, { name: 'old.txt' })).headers.location);
    await patch(`${TUS_PATH}/${stale}`, 0, Buffer.from('123456'));
    const fresh = path.basename((await create(10, { name: 'new.txt' })).headers.location);
    const infoPath = path.join(stagingDir(), `${stale}.json`);
    const info = JSON.parse(await readFile(infoPath, 'utf8'));
    info.creation_date = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await writeFile(infoPath, JSON.stringify(info));
    // An expired upload can no longer be resumed.
    expect((await tus('HEAD', `${TUS_PATH}/${stale}`)).statusCode).toBe(410);

    await ctx.app.get(SchedulerService).maintenance();
    expect((await readdir(stagingDir())).sort()).toEqual([fresh, `${fresh}.json`]);
    expect(await readdir(userDir())).toEqual([]);
  });

  it('ENOSPC while publishing answers 507 and keeps the upload resumable', async () => {
    const data = randomBytes(1000);
    const created = await create(data.length, { name: 'full.bin' });
    const location = created.headers.location;
    jest.spyOn(fsp, 'link').mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    const res = await patch(location, 0, data);
    expect(res.statusCode).toBe(507);
    expect(res.json()).toMatchObject({ code: 'insufficient_storage' });
    expect(await readdir(userDir())).toEqual([]);
    // The staged part survives: HEAD shows the full offset and an empty PATCH retries the publish.
    expect((await tus('HEAD', location)).headers['upload-offset']).toBe(String(data.length));
    const retry = await patch(location, data.length, Buffer.alloc(0));
    expect(retry.statusCode).toBe(200);
    expect(await readFile(path.join(userDir(), 'full.bin'))).toEqual(data);
  });
});
