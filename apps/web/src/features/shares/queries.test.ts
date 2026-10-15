import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { absoluteUrl, shareStatus, useItemShares, useShareMutations, useShares } from './queries';

afterEach(() => { vi.restoreAllMocks(); });

describe('share queries', () => {
  it('lists all links and the links of one item', async () => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue([]);
    const { wrapper } = testQueryClient();
    const all = renderHook(() => useShares(), { wrapper });
    const one = renderHook(() => useItemShares('d_abc'), { wrapper });
    await waitFor(() => expect(all.result.current.isSuccess && one.result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith('/shares');
    expect(spy).toHaveBeenCalledWith('/shares?itemId=d_abc');
  });

  it.each([
    ['create', (m: ReturnType<typeof useShareMutations>) => m.create.mutateAsync({ itemId: 'f_1', allowDownload: true }), '/shares', { method: 'POST', json: { itemId: 'f_1', allowDownload: true } }],
    ['update', (m: ReturnType<typeof useShareMutations>) => m.update.mutateAsync({ id: 's1', patch: { expiresAt: null } }), '/shares/s1', { method: 'PATCH', json: { expiresAt: null } }],
    ['rotate', (m: ReturnType<typeof useShareMutations>) => m.rotate.mutateAsync('s1'), '/shares/s1/rotate', { method: 'POST' }],
    ['revoke', (m: ReturnType<typeof useShareMutations>) => m.revoke.mutateAsync('s1'), '/shares/s1', { method: 'DELETE' }],
  ])('%s calls the endpoint and refreshes every share list', async (_n, run, path, init) => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({});
    const { wrapper, invalidated } = testQueryClient();
    const { result } = renderHook(() => useShareMutations(), { wrapper });
    await act(async () => { await run(result.current); });
    expect(spy).toHaveBeenCalledWith(path, init);
    expect(invalidated()).toEqual([['shares']]);
  });
});

it('derives the status of a link', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  expect(shareStatus({ revokedAt: null, expiresAt: null }, now)).toBe('active');
  expect(shareStatus({ revokedAt: null, expiresAt: '2026-10-16T00:00:00Z' }, now)).toBe('active');
  expect(shareStatus({ revokedAt: null, expiresAt: '2026-10-15T12:00:00Z' }, now)).toBe('expired');
  expect(shareStatus({ revokedAt: '2026-10-01T00:00:00Z', expiresAt: null }, now)).toBe('revoked');
});

it('makes relative share URLs absolute', () => {
  expect(absoluteUrl('/s/tok')).toBe(`${window.location.origin}/s/tok`);
  expect(absoluteUrl('https://files.example.org/s/tok')).toBe('https://files.example.org/s/tok');
});
