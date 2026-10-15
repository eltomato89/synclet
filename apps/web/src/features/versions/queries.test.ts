import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { downloadVersion, useRestoreVersion, useVersions, versionContentUrl } from './queries';
import { canPreviewVersion } from './source';

afterEach(() => { vi.restoreAllMocks(); });

describe('version queries', () => {
  it('lists the versions of an item', async () => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue([]);
    const { wrapper } = testQueryClient();
    const { result } = renderHook(() => useVersions('f_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith('/sync/v1/items/f_1/versions');
  });

  it('builds the content URL with the token', () => {
    expect(versionContentUrl('f_1', 'v 1', 'a+b')).toBe('/api/sync/v1/items/f_1/versions/v%201/content?dt=a%2Bb');
  });

  it('downloads through a download token and the version route', async () => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({ token: 'tok', url: '/x' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    await downloadVersion('f_1', 'v1');
    expect(spy).toHaveBeenCalledWith('/sync/v1/items/f_1/download-token', { method: 'POST' });
    expect(assign).toHaveBeenCalledWith('/api/sync/v1/items/f_1/versions/v1/content?dt=tok');
    vi.unstubAllGlobals();
  });

  it('restore posts and refreshes versions, item and folder', async () => {
    const spy = vi.spyOn(apiMod, 'api').mockResolvedValue({});
    const { wrapper, invalidated } = testQueryClient();
    const { result } = renderHook(() => useRestoreVersion({ id: 'f_1', parentId: 'd_9' }), { wrapper });
    await act(async () => { await result.current.mutateAsync('v1'); });
    expect(spy).toHaveBeenCalledWith('/sync/v1/items/f_1/versions/v1/restore', { method: 'POST' });
    expect(invalidated()).toEqual(expect.arrayContaining([['versions', 'f_1'], ['item', 'f_1'], ['folder', 'd_9']]));
  });
});

it('previews only kinds that the content route can show', () => {
  const p = (name: string, kind: string) => ({ name, preview: { kind, thumbnail: true } }) as never;
  expect(canPreviewVersion(p('a.png', 'image'))).toBe(true);
  expect(canPreviewVersion(p('a.svg', 'image'))).toBe(false);
  expect(canPreviewVersion(p('a.heic', 'image'))).toBe(false);
  expect(canPreviewVersion(p('a.pdf', 'pdf'))).toBe(true);
  expect(canPreviewVersion(p('a.zip', 'none'))).toBe(false);
});
