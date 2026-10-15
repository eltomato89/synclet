import type { SyncItem } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { type ItemActions, ItemMenuButton } from './FileActions';

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

const item = (name: string, type: 'file' | 'folder' = 'file'): SyncItem => ({
  id: type === 'file' ? 'f_1' : 'd_1', parentId: 'root', type, kind: type, name, size: 1, mime: null, version: 1, sha256: null,
  etag: 'e', contentEtag: null, createdAt: '2026-10-15T10:00:00Z', modifiedAt: '2026-10-15T10:00:00Z', documentId: null,
  capabilities: { rename: true, move: true, delete: true, addChildren: type === 'folder' } as SyncItem['capabilities'],
});

function actions(office: boolean): ItemActions {
  return {
    open: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), share: vi.fn(),
    ...(office ? { openInOffice: vi.fn() } : {}),
  };
}

function menuLabels(it: SyncItem, a: ItemActions) {
  render(<ItemMenuButton item={it} actions={a} />);
  fireEvent.keyDown(screen.getByRole('button', { name: `Actions for ${it.name}` }), { key: 'Enter' });
  return within(screen.getByRole('menu')).getAllByRole('menuitem').map((m) => m.textContent ?? '');
}

it('offers "Open in Office" for office files when office is available', () => {
  const a = actions(true);
  const labels = menuLabels(item('Plan.docx'), a);
  expect(labels.some((l) => l.startsWith('Open in Office'))).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: /Open in Office/ }));
  expect(a.openInOffice).toHaveBeenCalledWith(expect.objectContaining({ name: 'Plan.docx' }));
});

it('hides it without office, for other file types and for folders', () => {
  expect(menuLabels(item('Plan.docx'), actions(false)).some((l) => l.includes('Office'))).toBe(false);
  cleanup();
  expect(menuLabels(item('photo.jpg'), actions(true)).some((l) => l.includes('Office'))).toBe(false);
  cleanup();
  expect(menuLabels(item('Folder.docx', 'folder'), actions(true)).some((l) => l.includes('Office'))).toBe(false);
});
