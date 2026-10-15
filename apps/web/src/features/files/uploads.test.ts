import { describe, expect, it, vi } from 'vitest';
import { UploadQueue } from './uploads';

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) };
  onload: null | (() => void) = null; onerror: null | (() => void) = null;
  status = 0; responseText = ''; headers: Record<string, string> = {}; url = ''; method = '';
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send() { FakeXHR.instances.push(this); }
  abort() {}
}

describe('UploadQueue', () => {
  it('uploads with raw body, progress and max 3 concurrent', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const q = new UploadQueue(() => 'tok', () => {});
    const files = Array.from({ length: 4 }, (_, i) => new File(['x'], `f${i}.txt`, { lastModified: 0 }));
    q.enqueue(files, 'root');
    expect(FakeXHR.instances).toHaveLength(3);
    const first = FakeXHR.instances[0];
    expect(first.url).toBe('/api/sync/v1/items/upload?parentId=root&name=f0.txt&onConflict=rename');
    expect(first.headers['Content-Type']).toBe('application/octet-stream');
    expect(first.headers.Authorization).toBe('Bearer tok');
    first.upload.onprogress?.({ loaded: 1, total: 2 });
    expect(q.snapshot()[0].progress).toBe(0.5);
    first.status = 201; first.responseText = JSON.stringify({ id: 'f_x' }); first.onload?.();
    await Promise.resolve();
    expect(q.snapshot()[0].status).toBe('done');
    expect(FakeXHR.instances).toHaveLength(4);
  });
});

describe('UploadQueue error handling', () => {
  const setup = (refresh?: () => Promise<boolean>) => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const done = vi.fn();
    return { q: new UploadQueue(() => 'tok', done, refresh), done };
  };
  const file = (name = 'a.txt', size = 1) => new File(['x'.repeat(size)], name, { lastModified: Date.UTC(2024, 0, 2) });

  it('sends the modification time and surfaces server error codes', () => {
    const { q } = setup();
    q.enqueue([file()], 'd_1');
    const x = FakeXHR.instances[0];
    expect(x.headers['X-Synclet-Modified-At']).toBe('2024-01-02T00:00:00.000Z');
    x.status = 400; x.responseText = JSON.stringify({ statusCode: 400, code: 'invalid_name', message: 'bad' }); x.onload?.();
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'invalid_name' });
  });

  it('maps conflicts to the conflict status and non-JSON errors by HTTP status', () => {
    const { q } = setup();
    q.enqueue([file('a.txt'), file('b.txt')], 'root');
    const [a, b] = FakeXHR.instances;
    a.status = 409; a.responseText = JSON.stringify({ code: 'name_conflict' }); a.onload?.();
    b.status = 413; b.responseText = '<html>too big</html>'; b.onload?.();
    expect(q.snapshot().map((t) => [t.status, t.error])).toEqual([['conflict', 'name_conflict'], ['error', 'too_large']]);
  });

  it('rejects files above the upload limit without sending them', () => {
    const { q } = setup();
    q.setMaxUploadBytes(3);
    q.enqueue([file('big.bin', 4), file('ok.txt', 2)], 'root');
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0].url).toContain('name=ok.txt');
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'too_large' });
  });

  it('refreshes the session once on 401 and retries', async () => {
    const refresh = vi.fn().mockResolvedValue(true);
    const { q, done } = setup(refresh);
    q.enqueue([file()], 'root');
    const first = FakeXHR.instances[0];
    first.status = 401; first.responseText = JSON.stringify({ code: 'unauthorized' }); first.onload?.();
    await Promise.resolve(); await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    expect(FakeXHR.instances).toHaveLength(2);
    const second = FakeXHR.instances[1];
    second.status = 401; second.responseText = '{}'; second.onload?.();
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'unauthorized' });
    q.retry(q.snapshot()[0].id);
    const third = FakeXHR.instances[2];
    third.status = 201; third.responseText = JSON.stringify({ id: 'f_1' }); third.onload?.();
    expect(q.snapshot()[0].status).toBe('done');
    expect(done).toHaveBeenCalledWith('root');
  });

  it('network errors can be retried; cancel removes a task and frees its slot', () => {
    const { q } = setup();
    q.enqueue([file('1'), file('2'), file('3'), file('4')], 'root');
    FakeXHR.instances[0].onerror?.();
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'network' });
    expect(FakeXHR.instances).toHaveLength(4);
    q.cancel(q.snapshot()[1].id);
    expect(q.snapshot().map((t) => t.file.name)).toEqual(['1', '3', '4']);
    q.retry(q.snapshot()[0].id);
    expect(FakeXHR.instances).toHaveLength(5);
  });

  it('a rejected session refresh fails the task with network and frees the slot', async () => {
    const { q } = setup(vi.fn().mockRejectedValue(new Error('offline')));
    q.enqueue([file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt')], 'd_1');
    const first = FakeXHR.instances[0];
    first.status = 401; first.responseText = '{}'; first.onload?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'network' });
    expect(FakeXHR.instances).toHaveLength(4); // queued task took the freed slot
  });

  it('a 2xx response with an unparsable body fails the task with server_error', () => {
    const { q, done } = setup();
    q.enqueue([file()], 'd_1');
    const x = FakeXHR.instances[0];
    x.status = 201; x.responseText = '<html>proxy</html>'; x.onload?.();
    expect(q.snapshot()[0]).toMatchObject({ status: 'error', error: 'server_error' });
    expect(done).not.toHaveBeenCalled();
  });
});
