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
  const T0 = '2026-10-16T10:00:00.000Z';
  const release = (tag: string, url = `https://github.com/eltomato89/synclet/releases/tag/${tag}`) =>
    new Response(JSON.stringify({ tag_name: tag, html_url: url }), { status: 200, headers: { 'content-type': 'application/json' } });
  function make(over: Partial<AppConfig> = {}) {
    const svc = new UpdateCheckService({ ...loadConfig({}), buildVersion: '0.1.2', buildRevision: 'abcdef0123', ...over });
    svc.fetch = fetchMock as unknown as typeof fetch;
    svc.now = () => now;
    return svc;
  }
  /** One status request (which may start a background check), then the next one after that check finished. */
  async function check(svc: UpdateCheckService) {
    svc.info();
    await svc.idle();
    return svc.info();
  }
  beforeEach(() => {
    now = Date.parse(T0);
    fetchMock = jest.fn();
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no real network in tests'));
  });
  afterEach(() => jest.restoreAllMocks());

  it('never waits for GitHub: the first answer is "checking", the check runs in the background', async () => {
    let answer!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { answer = r; }));
    const svc = make();
    expect(svc.info()).toEqual({ installed: '0.1.2', revision: 'abcdef0123', latest: null, latestUrl: null, checkedAt: null, status: 'checking' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(svc.info().status).toBe('checking'); // still running: no second request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer(release('v0.1.10'));
    await svc.idle();
    expect(svc.info()).toEqual({
      installed: '0.1.2', revision: 'abcdef0123', latest: '0.1.10',
      latestUrl: 'https://github.com/eltomato89/synclet/releases/tag/v0.1.10', checkedAt: T0, status: 'update-available',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/eltomato89/synclet/releases/latest');
    expect(init.headers['User-Agent']).toBe('synclet/0.1.2');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('is up to date on the same or an older release, and asks the configured repo', async () => {
    fetchMock.mockResolvedValue(release('v0.1.2', 'https://github.com/me/fork/releases/tag/v0.1.2'));
    expect(await check(make({ updateRepo: 'me/fork' }))).toMatchObject({ status: 'up-to-date', latestUrl: 'https://github.com/me/fork/releases/tag/v0.1.2' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/me/fork/releases/latest');
    fetchMock.mockResolvedValue(release('0.1.1'));
    expect(await check(make({ buildVersion: 'v0.1.2' }))).toMatchObject({ installed: '0.1.2', latest: '0.1.1', status: 'up-to-date' });
  });

  it('caches a successful answer for 12 hours; checkedAt is the time of the last success', async () => {
    fetchMock.mockResolvedValueOnce(release('v0.1.2')).mockResolvedValueOnce(release('v0.1.3'));
    const svc = make();
    expect(await check(svc)).toMatchObject({ status: 'up-to-date', checkedAt: T0 });
    now += UPDATE_TTL_MS - 1;
    expect((await check(svc)).status).toBe('up-to-date');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 1;
    // Due: this answer is still the cached one, the refresh runs in the background.
    expect(svc.info()).toMatchObject({ status: 'up-to-date', checkedAt: T0 });
    await svc.idle();
    expect(svc.info()).toMatchObject({ status: 'update-available', latest: '0.1.3', checkedAt: new Date(now).toISOString() });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failure after 1 hour, keeping the last known release (and its checkedAt) meanwhile', async () => {
    fetchMock.mockResolvedValueOnce(new Response('rate limited', { status: 403 })).mockResolvedValueOnce(release('v0.1.3'));
    const svc = make();
    expect(svc.info().status).toBe('checking');
    await svc.idle();
    expect(svc.info()).toMatchObject({ status: 'unavailable', latest: null, latestUrl: null, checkedAt: null });
    now += UPDATE_RETRY_MS - 1;
    expect((await check(svc)).status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 1;
    expect(svc.info().status).toBe('checking'); // the retry is running
    const success = new Date(now).toISOString();
    expect(await check(svc)).toMatchObject({ status: 'update-available', checkedAt: success });
    // A later failure still shows the release found before, with the time it was found.
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    now += UPDATE_TTL_MS;
    expect(await check(svc)).toMatchObject({ status: 'update-available', latest: '0.1.3', checkedAt: success });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // ... and retries after 1 hour, not 12.
    fetchMock.mockResolvedValueOnce(release('v0.1.4'));
    now += UPDATE_RETRY_MS;
    expect(await check(svc)).toMatchObject({ latest: '0.1.4' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('is unavailable on network errors, timeouts and odd answers', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await check(make())).status).toBe('unavailable');
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect((await check(make())).status).toBe('unavailable');
    fetchMock.mockResolvedValue(new Response('{"message":"Not Found"}', { status: 404 }));
    expect((await check(make())).status).toBe('unavailable');
    fetchMock.mockResolvedValue(release('nightly'));
    expect((await check(make())).status).toBe('unavailable');
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    expect((await check(make())).status).toBe('unavailable');
  });

  it('aborts a hanging request after the timeout', async () => {
    const ctl = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(ctl.signal);
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const svc = make();
    expect(svc.info().status).toBe('checking');
    expect(timeout).toHaveBeenCalledWith(UPDATE_TIMEOUT_MS);
    ctl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await svc.idle();
    expect(svc.info().status).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1); // the failure is remembered: no new request right away
  });

  it('links only release pages of the checked repository', async () => {
    fetchMock.mockResolvedValue(release('v0.2.0', 'https://evil.example/x'));
    expect((await check(make())).latestUrl).toBe('https://github.com/eltomato89/synclet/releases/tag/v0.2.0');
    fetchMock.mockResolvedValue(release('v0.2.0', 'https://github.com/someone-else/synclet/releases/tag/v0.2.0'));
    expect((await check(make())).latestUrl).toBe('https://github.com/eltomato89/synclet/releases/tag/v0.2.0');
  });

  it('makes no request when disabled', async () => {
    const svc = make({ updateCheck: false });
    expect(svc.info()).toEqual({ installed: '0.1.2', revision: 'abcdef0123', latest: null, latestUrl: null, checkedAt: null, status: 'disabled' });
    await svc.idle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['edge', 'dev', 'sha-abc1234', 'unknown'])('treats %s as a development build without asking GitHub', async (v) => {
    const svc = make({ buildVersion: v });
    expect(svc.info()).toMatchObject({ installed: v, status: 'development', latest: null });
    await svc.idle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
