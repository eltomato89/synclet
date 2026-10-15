import { afterEach, describe, expect, it } from 'vitest';
import { contract, drainChanges, scratchFolder } from '../src/context.js';
import { schemaErrors } from '../src/schema.js';

const { ctx, api } = contract();

/** Ping interval of the server under test (`SYNCLET_EVENTS_PING_SECONDS`, default 25 s). */
const pingMs = (Number(process.env.SYNCLET_EVENTS_PING_SECONDS) || 25) * 1000;

interface SseEvent { event: string; data: any }

/** Reads `GET /sync/v1/events` incrementally. */
class EventStream {
  readonly events: SseEvent[] = [];
  pings = 0;
  ended = false;
  private waiters: (() => void)[] = [];
  private constructor(readonly res: Response, private readonly abort: AbortController) {}

  static async open(token: string | null): Promise<EventStream> {
    const abort = new AbortController();
    const res = await fetch(api.url('/sync/v1/events'), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: abort.signal,
    });
    const s = new EventStream(res, abort);
    if (res.ok && res.body) void s.pump(res.body);
    return s;
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) { this.pings++; continue; }
          let event = 'message'; let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trimStart();
          }
          this.events.push({ event, data: data ? JSON.parse(data) : null });
        }
        this.wake();
      }
    } catch { /* aborted */ }
    this.ended = true;
    this.wake();
  }

  private wake() { for (const w of this.waiters.splice(0)) w(); }

  until(pred: () => boolean, ms: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms; got ${JSON.stringify(this.events)}`)), ms);
      const check = () => {
        if (pred()) { clearTimeout(timer); resolve(); } else this.waiters.push(check);
      };
      check();
    });
  }

  of(event: string) { return this.events.filter((e) => e.event === event); }
  close() { this.abort.abort(); }
}

describe('events (SSE)', () => {
  const open: EventStream[] = [];
  const connect = async (token: string | null = ctx.token) => {
    const s = await EventStream.open(token);
    open.push(s);
    return s;
  };
  afterEach(() => { for (const s of open.splice(0)) s.close(); });

  it('rejects a request without a token (401)', async () => {
    const s = await connect(null);
    expect(s.res.status).toBe(401);
  });

  it('starts with hello, then a change via the API yields `changes` within 3 s', async () => {
    const s = await connect();
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get('cache-control')).toBe('no-cache, no-transform');
    await s.until(() => s.of('hello').length > 0, 5000, 'hello');
    const hello = s.of('hello')[0].data;
    expect(schemaErrors('EventHello', hello)).toBe('');

    const folder = await scratchFolder(api, ctx, 'events');
    await s.until(() => s.of('changes').length > 0, 3000, 'changes');
    const changes = s.of('changes').at(-1)!.data;
    expect(schemaErrors('EventChanges', changes)).toBe('');
    expect(changes.space).toBe('personal');
    // A wake-up only: the change itself comes from /changes.
    const drained = await drainChanges(api, hello.cursor);
    expect(drained.changes).toContainEqual({ op: 'upsert', item: expect.objectContaining({ id: folder.id }) });
    expect((await drainChanges(api, changes.cursor)).changes.some((c) => c.op === 'upsert' && c.item.id === folder.id)).toBe(false);
  });

  it(`sends a \`: ping\` comment (every ${pingMs / 1000} s)`, async () => {
    const s = await connect();
    await s.until(() => s.of('hello').length > 0, 5000, 'hello');
    await s.until(() => s.pings > 0, pingMs + 5000, 'ping');
    expect(s.ended).toBe(false);
  });
});
