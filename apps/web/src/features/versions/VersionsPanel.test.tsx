import type { SyncItem, VersionWire } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type ItemActions, ItemMenuButton } from '@/features/files/FileActions';
import i18n from '@/lib/i18n';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import type { ReactNode } from 'react';
import { relativeTime, VersionsPanel } from './VersionsPanel';

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const item = { id: 'f_1', parentId: 'd_1', type: 'file', kind: 'file', name: 'notes.txt', size: 5, mime: 'text/plain', etag: 'e', preview: { kind: 'text', thumbnail: false }, capabilities: { rename: true, move: true, delete: true } } as unknown as SyncItem;
const versions: VersionWire[] = [
  { id: 'v2', version: 2, size: 2048, sha256: 'b', modifiedAt: '2026-10-14T10:00:00Z', createdAt: '2026-10-15T10:00:00Z', source: 'office', createdBy: { id: 'u', displayName: 'Ada' } },
  { id: 'v1', version: 1, size: 10, sha256: 'a', modifiedAt: '2026-10-01T10:00:00Z', createdAt: '2026-10-14T10:00:00Z', source: 'restore', createdBy: null },
];

it('shows the menu entry only when the action is provided', () => {
  const base: ItemActions = { open: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), share: vi.fn() };
  const labels = (a: ItemActions) => {
    render(<ItemMenuButton item={item} actions={a} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for notes.txt' }), { key: 'Enter' });
    const l = screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
    cleanup();
    return l;
  };
  expect(labels(base).some((l) => l.startsWith('Versions'))).toBe(false);
  expect(labels({ ...base, versions: vi.fn() }).some((l) => l.startsWith('Versions'))).toBe(true);
});

it('lists versions with badges and restores after confirmation', async () => {
  const spy = vi.spyOn(apiMod, 'api').mockImplementation(async (_path: string, init) => {
    if (init?.method === 'POST') return item;
    return versions;
  });
  const { wrapper: qw, invalidated } = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => qw({ children: <TooltipProvider>{children}</TooltipProvider> });
  const onRestored = vi.fn();
  render(<VersionsPanel item={item} open onOpenChange={() => undefined} onRestored={onRestored} />, { wrapper });
  expect(await screen.findByText('Version 2')).toBeTruthy();
  expect(screen.getByText('Office')).toBeTruthy();
  expect(screen.getByText('Restored')).toBeTruthy();
  expect(screen.getByText(/2 KB, Ada/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
  expect(await screen.findByText(/saved as a version first/)).toBeTruthy();
  expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('restore'), expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(onRestored).toHaveBeenCalled());
  expect(spy).toHaveBeenCalledWith('/sync/v1/items/f_1/versions/v1/restore', { method: 'POST' });
  expect(invalidated()).toEqual(expect.arrayContaining([['versions', 'f_1'], ['folder', 'd_1']]));
});

it('shows an empty state', async () => {
  vi.spyOn(apiMod, 'api').mockResolvedValue([]);
  render(<VersionsPanel item={item} open onOpenChange={() => undefined} />, { wrapper: testQueryClient().wrapper });
  expect(await screen.findByText('No earlier versions')).toBeTruthy();
});

it('formats relative time', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  expect(relativeTime('2026-10-15T09:00:00Z', 'en', now)).toBe('3 hours ago');
  expect(relativeTime('2026-10-14T12:00:00Z', 'en', now)).toBe('yesterday');
  expect(relativeTime('2026-10-15T11:59:50Z', 'en', now)).toBe('now');
});

it('offers no restore for a read-only file (list, preview and download stay)', async () => {
  vi.spyOn(apiMod, 'api').mockResolvedValue(versions);
  const { wrapper: qw } = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => qw({ children: <TooltipProvider>{children}</TooltipProvider> });
  const ro = { ...item, capabilities: { read: true, write: false, rename: false, move: false, delete: false, addChildren: false } } as SyncItem;
  render(<VersionsPanel item={ro} open onOpenChange={() => undefined} />, { wrapper });
  expect(await screen.findByText('Version 2')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Download version 2/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Restore version/i })).toBeNull();
});
