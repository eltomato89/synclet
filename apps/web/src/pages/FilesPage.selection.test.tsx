import type { SyncItem } from '@synclet/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as bulkMod from '@/features/files/bulk';
import { ClipboardProvider } from '@/features/files/clipboard';
import { OperationsProvider } from '@/features/operations/OperationsProvider';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SPACES, syncItem } from '@/test/spaces';
import { FilesPage } from './FilesPage';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'lu', displayName: 'Lu', email: null, role: 'user' }, logout: async () => {} }),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= () => {}; // not in jsdom
  await i18n.changeLanguage('en');
});

let folders: Record<string, { folder: SyncItem; items: SyncItem[] }> = {};
beforeEach(() => {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string, opts?: { method?: string; json?: unknown }) => {
    if (path === '/sync/v1/account') return { canWrite: true, usedBytes: 0, quotaBytes: 0, maxUploadBytes: 0, spaces: SPACES };
    if (path === '/sync/v1/capabilities') return { versions: false, office: { enabled: false, url: null } };
    if (path === '/sync/v1/operations?active=1') return [];
    if (path === '/sync/v1/operations' && opts?.method === 'POST') {
      return { id: 'o1', kind: (opts.json as { kind: string }).kind, status: 'queued', targetId: null, targetName: null, itemCount: 1, totalItems: 1, doneItems: 0, totalBytes: 0, doneBytes: 0, conflict: null, results: [], error: null, createdAt: '2026-10-18T10:00:00Z', finishedAt: null };
    }
    if (path === '/sync/v1/download-zip') return { url: '/api/sync/v1/zip/t', expiresAt: '' };
    const m = /^\/sync\/v1\/items\/([^/?]+)(\/children)?/.exec(path);
    const f = m ? folders[m[1]] : undefined;
    if (f) return m![2] ? { items: f.items, nextPageToken: null, cursor: '1' } : f.folder;
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); folders = {}; });

function renderAt(path: string) {
  const q = testQueryClient();
  render(
    <q.wrapper>
      <MemoryRouter initialEntries={[path]}>
        <TooltipProvider><TopbarProvider><OperationsProvider><ClipboardProvider>
          <Topbar onOpenNavigation={() => {}} />
          <Routes>
            <Route path="/files" element={<FilesPage />} />
            <Route path="/files/:folderId" element={<FilesPage />} />
          </Routes>
        </ClipboardProvider></OperationsProvider></TopbarProvider></TooltipProvider>
      </MemoryRouter>
    </q.wrapper>,
  );
  return q;
}

const folder = syncItem({ id: 'root', name: 'Meine Dateien', parentId: null, type: 'folder', kind: 'root' });
// Folders sort first: Box, a.txt … d.txt.
const box = syncItem({ id: 'd_9', name: 'Box', type: 'folder', kind: 'folder' });
const files = [box, ...['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name, i) => syncItem({ id: `f_${i}`, name }))];
const row = (name: string) => screen.getByText(name).closest('tr')!;
const selected = () => screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.textContent?.match(/Box|[a-d]\.txt/)?.[0]);

beforeEach(() => { folders.root = { folder, items: files }; });

it('click, ⌘-click and shift-click select like the Finder', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('c.txt'), { shiftKey: true });
  expect(selected()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  fireEvent.click(row('b.txt'), { metaKey: true });
  expect(selected()).toEqual(['a.txt', 'c.txt']);
  fireEvent.click(row('d.txt'));
  expect(selected()).toEqual(['d.txt']);
  expect(screen.getByRole('grid')).toHaveAttribute('aria-multiselectable', 'true');
});

it('keyboard: shift+arrows, ⌘A, Escape; live region announces the count', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.keyDown(row('a.txt'), { key: 'ArrowDown', shiftKey: true });
  fireEvent.keyDown(row('b.txt'), { key: 'ArrowDown', shiftKey: true });
  expect(selected()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect(screen.getByText('3 selected', { selector: '[aria-live]' })).toBeInTheDocument();
  fireEvent.keyDown(row('c.txt'), { key: 'a', metaKey: true });
  expect(selected()).toHaveLength(5);
  fireEvent.keyDown(row('c.txt'), { key: 'Escape' });
  expect(selected()).toEqual([]);
});

it('⌘+arrows move only the focus, ⌘+Space toggles', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.keyDown(row('a.txt'), { key: 'ArrowDown', metaKey: true });
  fireEvent.keyDown(row('b.txt'), { key: 'ArrowDown', metaKey: true });
  expect(document.activeElement).toBe(row('c.txt'));
  fireEvent.keyDown(row('c.txt'), { key: ' ', metaKey: true });
  expect(selected()).toEqual(['a.txt', 'c.txt']);
});

it('checkboxes toggle; the header checkbox selects all and none', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select “b.txt”' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select “d.txt”' }));
  expect(selected()).toEqual(['b.txt', 'd.txt']);
  const all = screen.getByRole('checkbox', { name: 'Select all' });
  expect(all).toHaveAttribute('data-state', 'indeterminate');
  fireEvent.click(all);
  expect(selected()).toHaveLength(5);
  fireEvent.click(all);
  expect(selected()).toEqual([]);
});

it('right-click on an unselected item selects only it; on a selected one keeps the selection', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('b.txt'), { metaKey: true });
  fireEvent.contextMenu(row('b.txt'));
  expect(selected()).toEqual(['a.txt', 'b.txt']);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); // close the menu
  fireEvent.contextMenu(row('d.txt'));
  expect(selected()).toEqual(['d.txt']);
});

it('items that disappear drop out of the selection', async () => {
  const { qc } = renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('b.txt'), { shiftKey: true });
  folders.root = { folder, items: files.filter((f) => f.name !== 'a.txt') };
  await act(() => qc.refetchQueries({ queryKey: ['folder', 'root'] }));
  await waitFor(() => expect(screen.queryByText('a.txt')).toBeNull());
  expect(selected()).toEqual(['b.txt']);
});

const tap = (el: Element) => { fireEvent.pointerDown(el, { pointerType: 'touch' }); fireEvent.click(el); };
/** Tapping the Box folder navigated away from the listing (d_9 is no valid folder id, so the page shows "not found"). */
const navigatedAway = () => screen.queryByText('a.txt') === null;

it('touch: a tap opens; only after a checkbox check do taps toggle', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select “b.txt”' }));
  tap(row('c.txt'));
  tap(row('Box'));
  expect(selected()).toEqual(['Box', 'b.txt', 'c.txt']);
  expect(navigatedAway()).toBe(false);
  tap(row('b.txt'));
  tap(row('c.txt'));
  tap(row('Box'));
  expect(selected()).toEqual([]);
  // Selection empty: back to opening.
  tap(row('Box'));
  await waitFor(() => expect(navigatedAway()).toBe(true));
});

it('touch: a programmatic single selection (right-click) does not start toggle mode', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select “b.txt”' }));
  fireEvent.contextMenu(row('d.txt')); // replaces the selection with only d.txt
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  expect(selected()).toEqual(['d.txt']);
  tap(row('Box'));
  await waitFor(() => expect(navigatedAway()).toBe(true));
});

it('Delete with nothing selected does nothing', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.keyDown(row('a.txt'), { key: 'Escape' });
  fireEvent.keyDown(row('a.txt'), { key: 'Delete' });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

const posted = () => vi.mocked(apiMod.api).mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === 'POST').map(([p, o]) => [p, (o as { json?: unknown }).json]);

it('two selected: the selection bar replaces upload/new; bulk delete goes through an operation', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('b.txt'), { shiftKey: true });
  // The live region and the selection bar both show the count.
  expect(screen.getByText('2 selected', { selector: 'span' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('heading', { name: 'Move 2 items to the trash?' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
  await waitFor(() => expect(posted()).toContainEqual(['/sync/v1/operations', { kind: 'delete', itemIds: ['f_0', 'f_1'] }]));
});

it('Del with several selected opens the bulk delete dialog', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('c.txt'), { metaKey: true });
  fireEvent.keyDown(row('c.txt'), { key: 'Delete' });
  expect(await screen.findByRole('heading', { name: 'Move 2 items to the trash?' })).toBeInTheDocument();
});

it('⌘C then ⌘V pastes into the current folder as a copy operation', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('b.txt'), { metaKey: true });
  fireEvent.keyDown(row('b.txt'), { key: 'c', metaKey: true });
  fireEvent.keyDown(row('b.txt'), { key: 'v', metaKey: true });
  await waitFor(() => expect(posted()).toContainEqual(['/sync/v1/operations', { kind: 'copy', itemIds: ['f_0', 'f_1'], targetId: 'root' }]));
});

it('ZIP download asks for a ticket and navigates to it', async () => {
  const assign = vi.spyOn(bulkMod.nav, 'assign').mockImplementation(() => {});
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('d.txt'), { shiftKey: true });
  fireEvent.click(screen.getByRole('button', { name: 'Download (ZIP)' }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/sync/v1/zip/t'));
  expect(posted()).toContainEqual(['/sync/v1/download-zip', { itemIds: ['f_0', 'f_1', 'f_2', 'f_3'] }]);
});

it('right-click on a selected item offers the bulk menu', async () => {
  renderAt('/files');
  await screen.findByText('a.txt');
  fireEvent.click(row('a.txt'));
  fireEvent.click(row('b.txt'), { metaKey: true });
  fireEvent.contextMenu(row('a.txt'));
  expect(await screen.findByRole('menuitem', { name: /Download \(ZIP\)/ })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull();
});
