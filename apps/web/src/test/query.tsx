import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

/** A fresh QueryClient with a spy on `invalidateQueries`, plus a wrapper for renderHook/render. */
export function testQueryClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  /** Query keys passed to invalidateQueries so far. */
  const invalidated = () => invalidate.mock.calls.map((c) => c[0]?.queryKey);
  return { qc, wrapper, invalidated };
}
