import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setAccessToken } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api', () => {
  afterEach(() => { vi.restoreAllMocks(); setAccessToken(null); });

  it('sends the bearer token and parses JSON', async () => {
    setAccessToken('tok');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: 1 }));
    expect(await api('/health')).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }));
  });

  it('refreshes once on 401 and retries', async () => {
    setAccessToken('old');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new', user: { id: '1' } }))
      .mockResolvedValueOnce(json(200, { ok: 2 }));
    expect(await api('/thing')).toEqual({ ok: 2 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer new' }) });
  });

  it('throws ApiError with code and item', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(409, { statusCode: 409, code: 'name_conflict', message: 'exists', item: { id: 'f_1' } }));
    await expect(api('/x', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 409, code: 'name_conflict', item: { id: 'f_1' } });
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
  });
});
