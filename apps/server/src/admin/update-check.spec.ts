import { AppConfig, loadConfig } from '../config';
import { compareVersions, parseVersion, UPDATE_RETRY_MS, UPDATE_TIMEOUT_MS, UPDATE_TTL_MS, UpdateCheckService } from './update-check.service';

describe('version comparison', () => {
  it('parses releases only', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v0.1.10')).toEqual([0, 1, 10]);
    for (const v of ['edge', 'dev', 'unknown', 'sha-abc1234', '1.2.3-rc.1', '', null]) expect(parseVersion(v)).toBeNull();
  });

  it('compares numerically and ignores a leading v', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('v1.2.0', '1.2')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('edge', '1.0.0')).toBeNull();
  });
});

describe('UpdateCheckService', () => {
  let now: number;
  let fetchMock: jest.Mock;
  const release = (tag: string, url = `https://github.com/eltomato89/synclet/releases/tag/${tag}`) =>
    new Response(JSON.stringify({ tag_name: tag, html_url: url }), { status: 200, headers: { 'content-type': 'application/json' } });
  function make(over: Partial<AppConfig> = {}) {
    const svc = new UpdateCheckService({ ...loadConfig({}), buildVersion: '0.1.2', buildRevision: 'abcdef0123', ...over });
    svc.fetch = fetchMock as unknown as typeof fetch;
    svc.now = () => now;
    return svc;
  }
  beforeEach(() => {
    now = Date.parse('2026-10-16T10:00:00Z');
    fetchMock = jest.fn();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no real network in tests'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('reports an available update with the release notes link', async () => {
    fetchMock.mockResolvedValue(release('v0.1.10'));
    const info = await make().info();
    expect(info).toEqual({
      installed: '0.1.2', revision: 'abcdef0123', latest: '0.1.10',
      latestUrl: 'https://github.com/eltomato89/synclet/releases/tag/v0.1.10', checkedAt: '2026-10-16T10:00:00.000Z', status: 'update-available',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/eltomato89/synclet/releases/latest');
    expect(init.headers['User-Agent']).toBe('synclet/0.1.2');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is up to date on the same or an older release, and asks the configured repo', async () => {
    fetchMock.mockResolvedValue(release('v0.1.2'));
    expect((await make({ updateRepo: 'me/fork' }).info()).status).toBe('up-to-date');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/me/fork/releases/latest');
    fetchMock.mockResolvedValue(release('0.1.1'));
    expect(await make({ buildVersion: 'v0.1.2' }).info()).toMatchObject({ installed: '0.1.2', latest: '0.1.1', status: 'up-to-date' });
  });

  it('caches a successful answer for 12 hours', async () => {
    fetchMock.mockResolvedValueOnce(release('v0.1.2')).mockResolvedValueOnce(release('v0.1.3'));
    const svc = make();
    expect((await svc.info()).status).toBe('up-to-date');
    now += UPDATE_TTL_MS - 1;
    expect((await svc.info()).status).toBe('up-to-date');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await svc.info()).toMatchObject({ status: 'update-available', latest: '0.1.3' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failure after 1 hour, keeping the last known release meanwhile', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 403 })).mockResolvedValueOnce(release('v0.1.3'));
    const svc = make();
    expect(await svc.info()).toMatchObject({ status: 'unavailable', latest: null, latestUrl: null, checkedAt: '2026-10-16T10:00:00.000Z' });
    now += UPDATE_RETRY_MS - 1;
    expect((await svc.info()).status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 1;
    expect((await svc.info()).status).toBe('update-available');
    // A later failure still shows the release found before.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    now += UPDATE_TTL_MS;
    expect(await svc.info()).toMatchObject({ status: 'update-available', latest: '0.1.3' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('is unavailable on network errors, timeouts and odd answers', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await make().info()).status).toBe('unavailable');
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect((await make().info()).status).toBe('unavailable');
    fetchMock.mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    expect((await make().info()).status).toBe('unavailable');
    fetchMock.mockResolvedValue(release('nightly'));
    expect((await make().info()).status).toBe('unavailable');
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    expect((await make().info()).status).toBe('unavailable');
  });

  it('aborts a hanging request after the timeout', async () => {
    const ctl = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(ctl.signal);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const pending = make().info();
    expect(timeout).toHaveBeenCalledWith(UPDATE_TIMEOUT_MS);
    ctl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect((await pending).status).toBe('unavailable');
  });

  it('only asks once for concurrent requests', async () => {
    fetchMock.mockResolvedValue(release('v0.1.2'));
    const svc = make();
    await Promise.all([svc.info(), svc.info(), svc.info()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a release URL outside github.com', async () => {
    fetchMock.mockResolvedValue(release('v0.2.0', 'https://evil.example/x'));
    expect((await make().info()).latestUrl).toBe('https://github.com/eltomato89/synclet/releases/tag/v0.2.0');
  });

  it('makes no request when disabled', async () => {
    expect(await make({ updateCheck: false }).info()).toEqual({
      installed: '0.1.2', revision: 'abcdef0123', latest: null, latestUrl: null, checkedAt: null, status: 'disabled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['edge', 'dev', 'sha-abc1234', 'unknown'])('treats %s as a development build without asking GitHub', async (v) => {
    expect(await make({ buildVersion: v }).info()).toMatchObject({ installed: v, status: 'development', latest: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
