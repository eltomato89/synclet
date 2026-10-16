import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => apiMock(...args) }));

const { clearPreviewTokens, PREVIEW_TOKEN_CACHE_MS, previewToken } = await import('./preview-url');
const { hasThumbnail, thumbnailUrl } = await import('./thumbnails');

let n = 0;
beforeEach(() => {
  clearPreviewTokens();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    n++;
    const id = /items\/([^/]+)\//.exec(path)![1];
    return { url: `/api/sync/v1/items/${id}/content?dt=tok${n}`, token: `tok${n}`, expiresAt: '' };
  });
});
afterEach(() => { vi.useRealTimers(); });

const file = (id: string, etag = 'v1', thumbnail = true) => ({
  id, etag, type: 'file' as const, preview: { kind: 'image' as const, thumbnail },
});

describe('preview token cache', () => {
  it('asks for a preview-purpose token and reuses it per item id + etag', async () => {
    const a = await previewToken(file('f_a'));
    const again = await previewToken(file('f_a'));
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock).toHaveBeenCalledWith('/sync/v1/items/f_a/download-token?purpose=preview', { method: 'POST' });
    expect(again).toEqual(a);
    expect(a.contentUrl).toBe(`/api/sync/v1/items/f_a/content?dt=${a.token}`);
  });

  it('shares one request between concurrent callers', async () => {
    const [x, y] = await Promise.all([previewToken(file('f_a')), previewToken(file('f_a'))]);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(x).toBe(y);
  });

  it('a new etag (new version) gets a new token', async () => {
    const v1 = await previewToken(file('f_a', 'v1'));
    const v2 = await previewToken(file('f_a', 'v2'));
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(v2.token).not.toBe(v1.token);
  });

  it('expires after 5 h (the server token lives 6 h)', async () => {
    const t0 = 1_000_000;
    const first = await previewToken(file('f_a'), t0);
    expect(await previewToken(file('f_a'), t0 + PREVIEW_TOKEN_CACHE_MS - 1)).toEqual(first);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const renewed = await previewToken(file('f_a'), t0 + PREVIEW_TOKEN_CACHE_MS);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(renewed.token).not.toBe(first.token);
    expect(PREVIEW_TOKEN_CACHE_MS).toBe(5 * 3600 * 1000);
  });

  it('does not cache failures', async () => {
    apiMock.mockRejectedValueOnce(new Error('offline'));
    await expect(previewToken(file('f_a'))).rejects.toThrow('offline');
    await expect(previewToken(file('f_a'))).resolves.toMatchObject({ token: expect.any(String) });
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('runs at most 6 token requests at once', async () => {
    const pending: (() => void)[] = [];
    let inFlight = 0; let peak = 0;
    apiMock.mockImplementation(() => new Promise((resolve) => {
      inFlight++; peak = Math.max(peak, inFlight);
      pending.push(() => { inFlight--; resolve({ url: '/x?dt=t', token: 't' }); });
    }));
    const all = Promise.all(Array.from({ length: 10 }, (_, i) => previewToken(file(`f_${i}`))));
    await Promise.resolve();
    expect(apiMock).toHaveBeenCalledTimes(6);
    while (pending.length) { pending.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await all;
    expect(apiMock).toHaveBeenCalledTimes(10);
    expect(peak).toBe(6);
  });
});

describe('thumbnail URLs', () => {
  it('builds a 256/1024 URL with the cached token and a version buster', async () => {
    const small = await thumbnailUrl(file('f_a', 'v3'), 256);
    const large = await thumbnailUrl(file('f_a', 'v3'), 1024);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(small).toBe('/api/sync/v1/items/f_a/thumbnail?size=256&v=v3&dt=tok' + n);
    expect(large).toBe('/api/sync/v1/items/f_a/thumbnail?size=1024&v=v3&dt=tok' + n);
  });

  it('never requests anything for items without preview.thumbnail', async () => {
    expect(await thumbnailUrl(file('f_a', 'v1', false), 256)).toBeNull();
    expect(await thumbnailUrl({ id: 'f_b', etag: 'v1', type: 'file' }, 256)).toBeNull();
    expect(await thumbnailUrl({ id: 'd_c', etag: 't0', type: 'folder' }, 256)).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
    expect(hasThumbnail(file('f_a'))).toBe(true);
  });
});
