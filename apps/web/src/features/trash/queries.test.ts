import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { expiresIn, parentSegments, retentionDays, useTrash, useTrashMutations } from './queries';

afterEach(() => { vi.restoreAllMocks(); });

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-15T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe('expiresIn', () => {
  it('rounds whole days up, so a fresh entry with 30 days retention reads 30', () => {
    expect(expiresIn(at(30 * DAY), NOW)).toEqual({ kind: 'days', days: 30 });
    expect(expiresIn(at(30 * DAY - 60_000), NOW)).toEqual({ kind: 'days', days: 30 });
    expect(expiresIn(at(DAY + 1), NOW)).toEqual({ kind: 'days', days: 2 });
    expect(expiresIn(at(DAY), NOW)).toEqual({ kind: 'days', days: 1 });
  });
  it('reports less than a day (and overdue entries) as "today"', () => {
    expect(expiresIn(at(DAY - 1), NOW)).toEqual({ kind: 'today' });
    expect(expiresIn(at(-5 * 60_000), NOW)).toEqual({ kind: 'today' });
  });
  it('reports entries without expiry as never', () => {
    expect(expiresIn(null, NOW)).toEqual({ kind: 'never' });
  });
});

it('derives retention and parent folders', () => {
  const e = { deletedAt: at(-2 * DAY), expiresAt: at(28 * DAY) } as never;
  expect(retentionDays([e])).toBe(30);
  expect(retentionDays([])).toBeNull();
  expect(parentSegments('Fotos')).toEqual([]);
  expect(parentSegments('Docs/2026/plan.pdf')).toEqual(['Docs', '2026']);
});

describe('trash queries', () => {
  it('lists the trash from GET /trash', async () => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue([]);
    const { wrapper } = testQueryClient();
    const { result } = renderHook(() => useTrash(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith('/trash');
  });

  it.each([
    ['restore', (m: ReturnType<typeof useTrashMutations>) => m.restore.mutateAsync({ id: 't1' }), '/trash/t1/restore', 'POST'],
    ['deleteForever', (m: ReturnType<typeof useTrashMutations>) => m.deleteForever.mutateAsync({ id: 't1' }), '/trash/t1', 'DELETE'],
    ['empty', (m: ReturnType<typeof useTrashMutations>) => m.empty.mutateAsync(), '/trash', 'DELETE'],
  ])('%s calls the endpoint and refreshes trash, folders, account and shares', async (_n, run, path, method) => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({ removed: 1, item: {}, restoredTo: 'x', renamed: false });
    const { qc, wrapper, invalidated } = testQueryClient();
    qc.setQueryData(['trash'], [{ id: 't1' }, { id: 't2' }]);
    const { result } = renderHook(() => useTrashMutations(), { wrapper });
    await act(async () => { await run(result.current); });
    expect(spy).toHaveBeenCalledWith(path, { method });
    expect(invalidated()).toEqual(expect.arrayContaining([['trash'], ['account'], ['folder'], ['subfolders'], ['shares']]));
    expect(qc.getQueryData<{ id: string }[]>(['trash'])?.map((e) => e.id)).toEqual(path === '/trash' ? [] : ['t2']);
  });

  it('emptying drops only the personal entries from the list (other spaces are not emptied)', async () => {
    vi.spyOn(apiMod, 'api').mockResolvedValue({ removed: 1 });
    const { qc, wrapper } = testQueryClient();
    qc.setQueryData(['trash'], [{ id: 't1' }, { id: 't2', spaceId: 'personal' }, { id: 't3', spaceId: 'team-uuid' }]);
    const { result } = renderHook(() => useTrashMutations(), { wrapper });
    await act(async () => { await result.current.empty.mutateAsync(); });
    expect(qc.getQueryData<{ id: string }[]>(['trash'])?.map((e) => e.id)).toEqual(['t3']);
  });

  it('keeps the entry and still refetches when a restore fails with 409 conflict', async () => {
    vi.spyOn(apiMod, 'api').mockRejectedValue(new apiMod.ApiError(409, 'conflict', 'trash content not available'));
    const { qc, wrapper, invalidated } = testQueryClient();
    qc.setQueryData(['trash'], [{ id: 't1' }]);
    const { result } = renderHook(() => useTrashMutations(), { wrapper });
    await act(() => expect(result.current.restore.mutateAsync({ id: 't1' })).rejects.toMatchObject({ code: 'conflict' }));
    expect(qc.getQueryData(['trash'])).toEqual([{ id: 't1' }]);
    expect(invalidated()).toContainEqual(['trash']);
  });
});
