import type { SyncItem } from '@synclet/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import type { Picked } from './folderUpload';
import type { UploadQueue } from './uploads';
import { useFolderUpload } from './useFolderUpload';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: vi.fn() }));
beforeAll(async () => { await i18n.changeLanguage('en'); });

const folder = (name: string) => ({ id: `d_${name}`, name, type: 'folder' }) as SyncItem;
const pick = (top: string): Picked => ({ files: [{ path: `${top}/a.txt`, file: new File(['x'], 'a.txt') }, { path: 'lose.txt', file: new File(['y'], 'lose.txt') }], folders: [top] });

it('a second pick while the conflict dialog is open waits for the first instead of stranding it', async () => {
  const queue = { enqueue: vi.fn(), addGroup: vi.fn(), hasGroup: vi.fn(), updateGroup: vi.fn() } as unknown as UploadQueue;
  const { result } = renderHook(() => useFolderUpload({ queue, folderId: 'root', siblings: [folder('A'), folder('B')], onFoldersChanged: vi.fn() }));

  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => { first = result.current.upload(pick('A')); });
  await waitFor(() => expect(result.current.question?.name).toBe('A'));
  act(() => { second = result.current.upload(pick('B')); });
  // Still the first question; the second pick's loose file is queued right away.
  expect(result.current.question?.name).toBe('A');
  expect(queue.enqueue).toHaveBeenCalledTimes(2);

  act(() => result.current.answer({ choice: 'cancel', applyAll: false }));
  await act(async () => { await first; });
  await waitFor(() => expect(result.current.question?.name).toBe('B'));
  act(() => result.current.answer({ choice: 'cancel', applyAll: false }));
  await act(async () => { await second; });
  expect(result.current.question).toBeNull();
  expect(queue.addGroup).not.toHaveBeenCalled();
});
