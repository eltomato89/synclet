import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { ApiError } from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { FALLBACK_CAPABILITIES, fetchEditorConfig, useCapabilities, useCreateOfficeFile } from './queries';

afterEach(() => { vi.restoreAllMocks(); });

const enabled = { versions: true, office: { enabled: true, url: 'https://office.example.com' } };

it('reports the server capabilities', async () => {
  const spy = vi.spyOn(apiMod, 'api').mockResolvedValue(enabled);
  const { wrapper } = testQueryClient();
  const { result } = renderHook(() => useCapabilities(), { wrapper });
  expect(result.current).toEqual(FALLBACK_CAPABILITIES); // until loaded
  await waitFor(() => expect(result.current).toEqual(enabled));
  expect(spy).toHaveBeenCalledWith('/sync/v1/capabilities');
});

it('falls back to "nothing optional" on a server without the route', async () => {
  vi.spyOn(apiMod, 'api').mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
  const { wrapper, qc } = testQueryClient();
  const { result } = renderHook(() => useCapabilities(), { wrapper });
  await waitFor(() => expect(qc.getQueryState(['capabilities'])?.status).toBe('success'));
  expect(result.current).toEqual(FALLBACK_CAPABILITIES);
});

it('falls back on network failures, without caching them as the answer', async () => {
  vi.spyOn(apiMod, 'api').mockRejectedValue(new ApiError(0, 'network', 'down'));
  const { wrapper, qc } = testQueryClient();
  const { result } = renderHook(() => useCapabilities(), { wrapper });
  await waitFor(() => expect(qc.getQueryState(['capabilities'])?.status).toBe('error'), { timeout: 4000 });
  expect(result.current).toEqual(FALLBACK_CAPABILITIES);
});

it('asks for the editor config in the UI language', async () => {
  const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({});
  await fetchEditorConfig('f_1', 'de-DE');
  await fetchEditorConfig('f_1', 'en');
  await fetchEditorConfig('f_1', 'fr');
  expect(spy.mock.calls.map((c) => c[0])).toEqual([
    '/sync/v1/items/f_1/office?lang=de', '/sync/v1/items/f_1/office?lang=en', '/sync/v1/items/f_1/office?lang=en',
  ]);
});

it('creates a document and refreshes the folder', async () => {
  const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({ id: 'f_new' });
  const { wrapper, invalidated } = testQueryClient();
  const { result } = renderHook(() => useCreateOfficeFile(), { wrapper });
  await result.current.mutateAsync({ parentId: 'root', name: 'Plan.docx', format: 'docx' });
  expect(spy).toHaveBeenCalledWith('/sync/v1/items/new-office', { method: 'POST', json: { parentId: 'root', name: 'Plan.docx', format: 'docx' } });
  expect(invalidated()).toContainEqual(['folder', 'root']);
});
