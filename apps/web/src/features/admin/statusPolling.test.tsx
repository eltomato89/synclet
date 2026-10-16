import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { STATUS_REFRESH_MS, UPDATE_HINT_PENDING_MS, useAdminStatus } from './queries';

afterEach(() => { vi.restoreAllMocks(); });

const version = (status: 'checking' | 'up-to-date') => ({
  installed: '0.1.3', revision: null, latest: status === 'checking' ? null : '0.1.3', latestUrl: null,
  checkedAt: status === 'checking' ? null : '2026-10-16T10:00:00Z', status,
});

it('the status page asks again within seconds while the update check is running', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let n = 0;
    vi.spyOn(apiMod, 'api').mockImplementation(async () => {
      n += 1;
      return { version: version(n === 1 ? 'checking' : 'up-to-date') };
    });
    const { wrapper } = testQueryClient();
    const { result } = renderHook(() => useAdminStatus(), { wrapper });
    await waitFor(() => expect(result.current.data?.version.status).toBe('checking'));
    await vi.advanceTimersByTimeAsync(UPDATE_HINT_PENDING_MS);
    await waitFor(() => expect(result.current.data?.version.status).toBe('up-to-date'));
    expect(n).toBe(2);
    // A result exists: back to the normal 30 s interval.
    await vi.advanceTimersByTimeAsync(STATUS_REFRESH_MS - UPDATE_HINT_PENDING_MS - 100);
    expect(n).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
