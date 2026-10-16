import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { useGroupMutations, useSpaceMutations } from './queries';

afterEach(() => { vi.restoreAllMocks(); });

it('space and group changes also refresh the admin\'s own spaces (/account)', async () => {
  vi.spyOn(apiMod, 'api').mockResolvedValue(undefined as never);
  const { wrapper, invalidated } = testQueryClient();
  const spaces = renderHook(() => useSpaceMutations(), { wrapper });
  await spaces.result.current.update.mutateAsync({ id: 's1', patch: { members: [] } });
  await waitFor(() => expect(invalidated()).toEqual(expect.arrayContaining([['admin'], ['account']])));
  const n = invalidated().length;
  const groups = renderHook(() => useGroupMutations(), { wrapper });
  await groups.result.current.remove.mutateAsync('g1');
  await waitFor(() => expect(invalidated().slice(n)).toEqual(expect.arrayContaining([['admin'], ['account']])));
});
