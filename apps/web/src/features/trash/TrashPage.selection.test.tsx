import type { TrashEntryWire } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SPACES } from '@/test/spaces';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null, logout: async () => {} }) }));
beforeAll(async () => { await i18n.changeLanguage('en'); });

const entry = (id: string, name: string, originalPath: string): TrashEntryWire => ({
  id, itemId: `f_${id}`, type: 'file', name, originalPath, size: 1, deletedAt: '2026-10-15T10:00:00Z', expiresAt: null, itemCount: 1,
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const { TrashPage } = await import('./TrashPage');

let failing = new Set<string>();
let gate: Promise<void> | null = null;
const calls: string[] = [];
function renderWith(entries: TrashEntryWire[]) {
  let list = entries;
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (path === '/sync/v1/account') return { spaces: SPACES };
    if (path === '/trash') return list;
    const m = /^\/trash\/([^/]+)(\/restore)?$/.exec(path);
    if (m) {
      calls.push(`${opts?.method} ${path}`);
      if (gate) await gate;
      if (failing.has(m[1])) throw new apiMod.ApiError(404, 'not_found', 'x');
      list = list.filter((e) => e.id !== m[1]);
      return m[2] ? { item: { id: `f_${m[1]}`, name: 'x', parentId: 'root' }, restoredTo: '', renamed: false } : undefined;
    }
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
  const { wrapper: W } = testQueryClient();
  render(<W><MemoryRouter><TooltipProvider><TopbarProvider><Topbar onOpenNavigation={() => {}} /><TrashPage /></TopbarProvider></TooltipProvider></MemoryRouter></W>);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); failing = new Set(); gate = null; calls.length = 0; toast.success.mockReset(); toast.error.mockReset(); });

const rowOf = (name: string) => screen.getAllByText(name)[0].closest('tr')!;

it('restores several entries one after another; failed ones stay selected', async () => {
  renderWith([entry('1', 'a.txt', 'a.txt'), entry('2', 'b.txt', 'b.txt'), entry('3', 'c.txt', 'c.txt')]);
  await screen.findAllByText('a.txt');
  failing = new Set(['2']);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select “a.txt”' }));
  fireEvent.click(rowOf('c.txt'), { shiftKey: true });
  expect(screen.getByText('3 selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('2 restored, 1 failed', expect.anything()));
  expect(calls).toEqual(['POST /trash/1/restore', 'POST /trash/2/restore', 'POST /trash/3/restore']);
  await waitFor(() => expect(screen.queryByText('a.txt')).toBeNull());
  expect(rowOf('b.txt')).toHaveAttribute('aria-selected', 'true');
});

it('deletes several entries forever after confirmation; ⌘A selects all', async () => {
  renderWith([entry('1', 'a.txt', 'a.txt'), entry('2', 'b.txt', 'b.txt')]);
  await screen.findAllByText('a.txt');
  fireEvent.click(rowOf('a.txt'));
  fireEvent.keyDown(rowOf('a.txt'), { key: 'a', metaKey: true });
  expect(screen.getByText('2 selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
  expect(await screen.findByRole('heading', { name: 'Delete 2 items forever?' })).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete forever' }).at(-1)!);
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 items deleted forever', expect.anything()));
  expect(calls).toEqual(['DELETE /trash/1', 'DELETE /trash/2']);
});

it('the bulk buttons are disabled while a bulk run is in progress', async () => {
  renderWith([entry('1', 'a.txt', 'a.txt'), entry('2', 'b.txt', 'b.txt')]);
  await screen.findAllByText('a.txt');
  let release!: () => void;
  gate = new Promise((r) => { release = r; });
  fireEvent.click(rowOf('a.txt'));
  fireEvent.click(rowOf('b.txt'), { shiftKey: true });
  const restore = screen.getByRole('button', { name: 'Restore' });
  fireEvent.click(restore);
  await waitFor(() => expect(restore).toBeDisabled());
  expect(screen.getByRole('button', { name: 'Delete forever' })).toBeDisabled();
  fireEvent.click(restore);
  expect(calls).toEqual(['POST /trash/1/restore']);
  release();
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('2 items restored', expect.anything()));
  expect(calls).toEqual(['POST /trash/1/restore', 'POST /trash/2/restore']);
});
