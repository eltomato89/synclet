import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { AuthService } from '../auth/auth.service';
import { JournalService } from '../journal/journal.service';
import { ChangeNotifier } from './change-notifier';
import { EventsController } from './events.controller';

interface SseEvent { event: string; data: unknown }

/** A live SSE connection, parsed incrementally. */
class StreamClient {
  readonly events: SseEvent[] = [];
  pings = 0;
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  ended = false;
  body = '';
  private buf = '';
  private waiters: (() => void)[] = [];
  private req!: http.ClientRequest;

  static open(port: number, token: string | null): Promise<StreamClient> {
    const s = new StreamClient();
    return new Promise((resolve, reject) => {
      s.req = http.get({ host: '127.0.0.1', port, path: '/api/sync/v1/events', headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
        s.status = res.statusCode ?? 0;
        s.headers = res.headers;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => s.feed(chunk));
        res.on('end', () => { s.ended = true; s.wake(); });
        res.on('close', () => { s.ended = true; s.wake(); });
        resolve(s);
      });
      s.req.on('error', (e) => (s.status ? (s.ended = true, s.wake()) : reject(e)));
    });
  }

  private feed(chunk: string) {
    this.body += chunk;
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (block === ': ping') { this.pings++; continue; }
      let event = 'message'; let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      this.events.push({ event, data: data ? JSON.parse(data) : null });
    }
    this.wake();
  }

  private wake() { for (const w of this.waiters.splice(0)) w(); }

  /** Resolves once `pred` holds, or rejects after `ms`. */
  until(pred: () => boolean, ms: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (pred()) { clearTimeout(timer); resolve(); return; }
        this.waiters.push(check);
      };
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}; got ${JSON.stringify(this.events)}, pings=${this.pings}, ended=${this.ended}`)), ms);
      check();
    });
  }

  of(event: string) { return this.events.filter((e) => e.event === event); }
  close() { this.req.destroy(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GET /api/sync/v1/events (SSE)', () => {
  let ctx: TestContext; let port: number; let token: string; let deviceToken: string; let userId: string;
  const streams: StreamClient[] = [];
  const open = async (t: string | null = deviceToken) => {
    const s = await StreamClient.open(port, t);
    streams.push(s);
    return s;
  };
  const opened = async (t: string | null = deviceToken) => {
    const s = await open(t);
    await s.until(() => s.of('hello').length === 1, 3000, 'hello');
    return s;
  };
  const api = (method: string, url: string, payload?: object, t = token) =>
    ctx.app.inject({ method: method as 'GET', url: `/api${url}`, headers: { authorization: `Bearer ${t}` }, ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    ctx = await createTestApp({ eventsPingSeconds: 1 });
    await ctx.app.listen(0, '127.0.0.1');
    port = (ctx.app.getHttpServer().address() as AddressInfo).port;
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
    deviceToken = (await api('POST', '/sync/v1/devices', { name: 'Mac', platform: 'macos', appVersion: '1.0' })).json().token;
    // The LISTEN connection is established asynchronously at startup.
    await ctx.app.get(ChangeNotifier).ready;
  });
  afterEach(async () => {
    for (const s of streams.splice(0)) s.close();
    await ctx.close();
  });

  it('401 without a token', async () => {
    const s = await open(null);
    await s.until(() => s.ended, 3000, 'end');
    expect(s.status).toBe(401);
    expect(JSON.parse(s.body).code).toBe('unauthorized');
  });

  it('hello carries the same cursor as /account, with SSE headers', async () => {
    await api('POST', '/sync/v1/items', { parentId: 'root', type: 'folder', name: 'before' });
    const account = (await api('GET', '/sync/v1/account', undefined, deviceToken)).json();
    const s = await opened();
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(s.headers['cache-control']).toBe('no-cache, no-transform');
    expect(s.headers['x-accel-buffering']).toBe('no');
    expect(s.of('hello')[0].data).toEqual({ cursor: account.cursor });
    expect(account.cursor).not.toBe('0');
  });

  it('a folder created via the API yields `changes` with the new cursor within 3 s', async () => {
    const s = await opened();
    await api('POST', '/sync/v1/items', { parentId: 'root', type: 'folder', name: 'Neu' });
    const { cursor } = (await api('GET', '/sync/v1/cursor')).json();
    await s.until(() => s.of('changes').length > 0, 3000, 'changes');
    expect(s.of('changes')[0].data).toEqual({ space: 'personal', cursor });
  });

  it('a burst of commits is coalesced into fewer events', async () => {
    const s = await opened();
    const journal = ctx.app.get(JournalService);
    for (let i = 0; i < 5; i++) {
      await ctx.prisma.$transaction(async (tx) => {
        await journal.lockSpace(tx, userId);
        await journal.record(tx, userId, [{ id: `00000000-0000-4000-8000-00000000000${i}`, type: 'folder' }], 'upsert');
      });
    }
    await s.until(() => s.of('changes').length > 0, 3000, 'changes');
    await sleep(600);
    const { cursor } = (await api('GET', '/sync/v1/cursor')).json();
    expect(s.of('changes').at(-1)!.data).toEqual({ space: 'personal', cursor });
    expect(s.of('changes').length).toBeLessThan(5);
  });

  it('catches up at the next ping when no notification arrives (dead or ineffective LISTEN)', async () => {
    const notifier = ctx.app.get(ChangeNotifier);
    const swallow = jest.spyOn(notifier, 'notify').mockImplementation(() => undefined);
    const s = await opened();
    const pingsBefore = s.pings;
    await api('POST', '/sync/v1/items', { parentId: 'root', type: 'folder', name: 'silent' });
    const { cursor } = (await api('GET', '/sync/v1/cursor')).json();
    await s.until(() => s.of('changes').length > 0, 2500, 'changes from the ping catch-up');
    expect(swallow).toHaveBeenCalled(); // the notification itself was swallowed
    expect(s.of('changes')[0].data).toEqual({ space: 'personal', cursor });
    // Sent together with the next ping (changes first, then the ping), and only once.
    await s.until(() => s.pings > pingsBefore, 2000, 'ping');
    await s.until(() => s.pings > pingsBefore + 1, 2000, 'second ping');
    expect(s.of('changes')).toHaveLength(1);
    swallow.mockRestore();
  });

  it('a rolled-back journal transaction yields no event', async () => {
    const s = await opened();
    const journal = ctx.app.get(JournalService);
    await expect(ctx.prisma.$transaction(async (tx) => {
      await journal.lockSpace(tx, userId);
      await journal.record(tx, userId, [{ id: '00000000-0000-4000-8000-000000000001', type: 'folder' }], 'upsert');
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    await sleep(1000);
    expect(s.of('changes')).toEqual([]);
    expect((await api('GET', '/sync/v1/cursor')).json().cursor).toBe((s.of('hello')[0].data as { cursor: string }).cursor);
  });

  it('sends `: ping` at the configured interval', async () => {
    const s = await opened();
    await s.until(() => s.pings >= 1, 3000, 'ping');
  });

  it('revoking the device ends the stream at the next ping', async () => {
    const s = await opened();
    expect((await api('DELETE', '/sync/v1/devices/current', undefined, deviceToken)).statusCode).toBe(204);
    await s.until(() => s.ended, 3000, 'end of stream');
    expect(s.of('bye').at(-1)?.data).toEqual({ reason: 'unauthorized' });
    // Reconnecting is refused.
    const again = await open();
    await again.until(() => again.ended, 3000, 'end');
    expect(again.status).toBe(401);
  });

  it('a disabled user\'s stream ends at the next ping (web access token too)', async () => {
    const s = await opened(token);
    await ctx.prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });
    await s.until(() => s.ended, 3000, 'end of stream');
    expect(s.of('bye').at(-1)?.data).toEqual({ reason: 'unauthorized' });
  });

  it('streams that ended free their slot: 10 open, the newest 5 closed by the client, 5 more → no bye', async () => {
    const first: StreamClient[] = [];
    for (let i = 0; i < 10; i++) first.push(await opened());
    // Close the newest: were closed streams kept in the list, the next opens would evict the
    // oldest (still open) ones with `bye`.
    for (const s of first.slice(5)) s.close();
    await sleep(200);
    const more: StreamClient[] = [];
    for (let i = 0; i < 5; i++) more.push(await opened());
    await sleep(300);
    for (const s of [...first.slice(0, 5), ...more]) {
      expect(s.ended).toBe(false);
      expect(s.of('bye')).toEqual([]);
    }
  });

  it('a stream opened during shutdown is closed at once with bye server_shutdown', async () => {
    ctx.app.get(EventsController).onModuleDestroy();
    const s = await open();
    await s.until(() => s.ended, 3000, 'end');
    expect(s.of('bye')).toEqual([{ event: 'bye', data: { reason: 'server_shutdown' } }]);
  });

  it('opening an 11th stream closes the oldest with bye too_many_streams', async () => {
    const list: StreamClient[] = [];
    for (let i = 0; i < 11; i++) list.push(await opened());
    await list[0].until(() => list[0].ended, 3000, 'oldest stream closed');
    expect(list[0].of('bye')).toEqual([{ event: 'bye', data: { reason: 'too_many_streams' } }]);
    for (const s of list.slice(1)) expect(s.ended).toBe(false);
    // The 10 remaining streams all still get changes.
    await api('POST', '/sync/v1/items', { parentId: 'root', type: 'folder', name: 'x' });
    for (const s of list.slice(1)) await s.until(() => s.of('changes').length > 0, 3000, 'changes');
  });

  it('another user\'s change yields no event', async () => {
    const other = await createTestUser(ctx, 'bob');
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    const otherToken = await ctx.app.get(AuthService).signAccess(row);
    const mine = await opened();
    const theirs = await opened(otherToken);
    expect((await api('POST', '/sync/v1/items', { parentId: 'root', type: 'folder', name: 'bobs' }, otherToken)).statusCode).toBe(201);
    await theirs.until(() => theirs.of('changes').length > 0, 3000, 'changes for bob');
    await sleep(1000);
    expect(mine.of('changes')).toEqual([]);
  });

  it('limits stream opens per user (30 per minute → 429)', async () => {
    for (let i = 0; i < 30; i++) {
      const s = await opened();
      s.close();
    }
    const s = await open();
    await s.until(() => s.ended, 3000, 'end');
    expect(s.status).toBe(429);
    expect(Number(s.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(s.body).code).toBe('rate_limited');
  });
});
