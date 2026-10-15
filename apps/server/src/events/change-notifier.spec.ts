import { EventEmitter } from 'node:events';
import { ChangeNotifier, CHANGES_CHANNEL, ListenClient } from './change-notifier';

class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect = false) { super(); }
  async connect() { if (this.failConnect) throw new Error('ECONNREFUSED'); }
  async query(sql: string) { this.queries.push(sql); }
  async end() { this.ended = true; }
  push(payload: string, channel = CHANGES_CHANNEL) { this.emit('notification', { channel, payload }); }
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ChangeNotifier', () => {
  let clients: FakeClient[];
  let failNext: number;
  let n: ChangeNotifier;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    clients = [];
    failNext = 0;
    n = new ChangeNotifier({
      createClient: () => {
        const c = new FakeClient(failNext-- > 0);
        clients.push(c);
        return c;
      },
    });
  });
  afterEach(async () => {
    await n.stop();
    jest.useRealTimers();
  });

  it('LISTENs on synclet_changes', async () => {
    n.onModuleInit();
    await tick();
    expect(clients[0].queries).toEqual(['LISTEN synclet_changes']);
  });

  it('coalesces a burst: 5 notifies within 100 ms → 1 callback (trailing edge)', async () => {
    n.onModuleInit();
    await tick();
    const cb = jest.fn();
    n.subscribe('u1', cb);
    for (let i = 0; i < 5; i++) {
      clients[0].push('u1');
      jest.advanceTimersByTime(20);
    }
    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledTimes(1);
    // A later notification yields another callback.
    clients[0].push('u1');
    jest.advanceTimersByTime(250);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('only wakes the notified user and ignores other channels', async () => {
    n.onModuleInit();
    await tick();
    const a = jest.fn(); const b = jest.fn();
    n.subscribe('a', a); n.subscribe('b', b);
    clients[0].push('a');
    clients[0].push('b', 'other_channel');
    jest.advanceTimersByTime(300);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('unsubscribe stops callbacks (also a pending one)', async () => {
    n.onModuleInit();
    await tick();
    const cb = jest.fn(); const other = jest.fn();
    const off = n.subscribe('u1', cb);
    n.subscribe('u1', other);
    clients[0].push('u1');
    off();
    jest.advanceTimersByTime(300);
    expect(cb).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('reconnects with backoff after the connection is lost and wakes every subscriber', async () => {
    n.onModuleInit();
    await tick();
    const a = jest.fn(); const b = jest.fn();
    n.subscribe('a', a); n.subscribe('b', b);
    failNext = 1; // the first reconnect attempt fails too
    clients[0].emit('error', new Error('terminating connection due to administrator command'));
    clients[0].emit('end');
    expect(clients[0].ended).toBe(true);
    jest.advanceTimersByTime(999);
    expect(clients).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await tick();
    expect(clients).toHaveLength(2); // failed attempt → next after 2 s
    jest.advanceTimersByTime(1999);
    await tick();
    expect(clients).toHaveLength(2);
    jest.advanceTimersByTime(1);
    await tick();
    expect(clients).toHaveLength(3);
    expect(clients[2].queries).toEqual(['LISTEN synclet_changes']);
    jest.advanceTimersByTime(250);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('caps the backoff at 30 s', async () => {
    failNext = 100;
    n.onModuleInit();
    await tick();
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(30_000);
      await tick();
    }
    const before = clients.length;
    jest.advanceTimersByTime(30_000);
    await tick();
    expect(clients.length).toBe(before + 1);
  });

  it('does not connect when disabled', async () => {
    const off = new ChangeNotifier({ createClient: () => { throw new Error('must not connect'); }, enabled: false });
    off.onModuleInit();
    await tick();
    await off.stop();
  });
});
