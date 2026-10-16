import type { SyncAccount } from '@synclet/shared';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { EXT, SPACES, TEAM } from '@/test/spaces';
import { isUnavailable, markSpaceUnavailable, spaceIdOfRoot, spaceRootId, useSpaces, useUnavailableSpaces } from './useSpaces';

afterEach(() => { vi.restoreAllMocks(); });


it('maps space ids and root ids both ways', () => {
  expect(spaceRootId('personal')).toBe('root');
  expect(spaceRootId(TEAM)).toBe(`r_${TEAM}`);
  expect(spaceIdOfRoot('root')).toBe('personal');
  expect(spaceIdOfRoot(`r_${TEAM}`)).toBe(TEAM);
  expect(spaceIdOfRoot('d_123')).toBeNull();
});

it('loads the spaces from /account and looks them up by api id', async () => {
  const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({ usedBytes: 0, quotaBytes: 0, canWrite: true, spaces: SPACES } as Partial<SyncAccount>);
  const { wrapper } = testQueryClient();
  const { result } = renderHook(() => useSpaces(), { wrapper });
  await waitFor(() => expect(result.current.spaces).toHaveLength(3));
  expect(spy).toHaveBeenCalledWith('/sync/v1/account');
  expect(result.current.byId(TEAM)?.name).toBe('Familie');
  // Items of an older server carry no spaceId: they are personal.
  expect(result.current.byId(undefined)?.kind).toBe('personal');
  expect(result.current.byId('unknown')).toBeUndefined();
  expect(result.current.rootOf(EXT)).toBe(`r_${EXT}`);
  expect(result.current.rootOf('personal')).toBe('root');
});

it('refreshes every 30 s and on window focus', async () => {
  vi.spyOn(apiMod, 'api').mockResolvedValue({ spaces: SPACES });
  const { qc, wrapper } = testQueryClient();
  renderHook(() => useSpaces(), { wrapper });
  await waitFor(() => expect(qc.getQueryCache().find({ queryKey: ['account'] })?.state.data).toBeTruthy());
  const observers = qc.getQueryCache().find({ queryKey: ['account'] })!.observers;
  expect(observers.some((o) => o.options.refetchInterval === 30_000 && o.options.refetchOnWindowFocus === true)).toBe(true);
});

it('falls back to the personal space when the server lists no spaces', async () => {
  vi.spyOn(apiMod, 'api').mockResolvedValue({ usedBytes: 0, quotaBytes: 0, canWrite: true });
  const { wrapper } = testQueryClient();
  const { result } = renderHook(() => useSpaces(), { wrapper });
  await waitFor(() => expect(result.current.spaces).toHaveLength(1));
  expect(result.current.spaces[0]).toMatchObject({ id: 'personal', rootId: 'root', canWrite: true });
});

it('remembers spaces that answered 503 until they load again', async () => {
  const { qc, wrapper } = testQueryClient();
  const { result } = renderHook(() => useUnavailableSpaces(), { wrapper });
  expect(isUnavailable(result.current, TEAM)).toBe(false);
  markSpaceUnavailable(qc, TEAM, true);
  await waitFor(() => expect(isUnavailable(result.current, TEAM)).toBe(true));
  markSpaceUnavailable(qc, TEAM, false);
  await waitFor(() => expect(isUnavailable(result.current, TEAM)).toBe(false));
});
