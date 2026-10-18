import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SPACES, syncItem, TEAM } from '@/test/spaces';
import { MoveDialog } from './MoveDialog';

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
    if (path === '/sync/v1/account') return { canWrite: true, spaces: SPACES };
    if (path.includes('/children')) return { items: [], nextPageToken: null, cursor: '1' };
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('offers "My files" and every space with write access as top-level targets', async () => {
  const onMove = vi.fn(async () => {});
  const { wrapper: W } = testQueryClient();
  render(<W><MoveDialog open onOpenChange={() => {}} items={[syncItem({ id: 'f_1', name: 'a.txt' })]} expandedIds={[]} onMove={onMove} /></W>);
  const familie = await screen.findByRole('treeitem', { name: 'Familie' });
  expect(screen.getByRole('treeitem', { name: /My files/ })).toBeInTheDocument();
  // NAS is read-only: not a target.
  expect(screen.queryByRole('treeitem', { name: /NAS/ })).toBeNull();
  fireEvent.click(familie);
  fireEvent.click(screen.getByRole('button', { name: "Move to “Familie”" }));
  await waitFor(() => expect(onMove).toHaveBeenCalledWith({ id: `r_${TEAM}`, name: 'Familie' }));
});

it('with several items: title with the count, selected folders are no targets', async () => {
  const docs = syncItem({ id: 'd_1', name: 'Docs', type: 'folder', kind: 'folder' });
  const other = syncItem({ id: 'd_2', name: 'Other', type: 'folder', kind: 'folder' });
  vi.mocked(apiMod.api).mockImplementation(async (path: string) => {
    if (path === '/sync/v1/account') return { canWrite: true, spaces: SPACES };
    if (path.startsWith('/sync/v1/items/root/children')) return { items: [docs, other], nextPageToken: null, cursor: '1' };
    if (path.includes('/children')) return { items: [], nextPageToken: null, cursor: '1' };
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
  const { wrapper: W } = testQueryClient();
  render(<W><MoveDialog open onOpenChange={() => {}} items={[docs, syncItem({ id: 'f_2', name: 'b.txt' })]} expandedIds={[]} onMove={vi.fn(async () => {})} /></W>);
  expect(await screen.findByRole('heading', { name: 'Move 2 items' })).toBeInTheDocument();
  expect(await screen.findByRole('treeitem', { name: 'Docs' })).toBeDisabled();
  expect(screen.getByRole('treeitem', { name: 'Other' })).toBeEnabled();
});
