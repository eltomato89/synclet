import type { SyncItem } from '@synclet/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';

const apiMock = vi.fn();
vi.mock('@/lib/api', () => ({ api: (...args: unknown[]) => apiMock(...args) }));

const { FileGrid } = await import('./FileGrid');
const { clearPreviewTokens } = await import('@/features/preview/preview-url');

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  clearPreviewTokens();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    const id = /items\/([^/]+)\//.exec(path)![1];
    return { url: `/x/${id}`, token: `tok-${id}`, expiresAt: '' };
  });
});
afterEach(cleanup);

const base = {
  parentId: 'root', size: 0, mime: null, version: null, sha256: null, contentEtag: null,
  createdAt: '2026-10-15T10:00:00Z', modifiedAt: '2026-10-15T10:00:00Z', documentId: null,
  capabilities: { read: true, write: true, rename: true, move: true, delete: true, addChildren: true },
} as const;
const folder = (id: string, name: string, preview?: SyncItem['preview']): SyncItem =>
  ({ ...base, id, name, type: 'folder', kind: 'folder', etag: 't1', ...(preview ? { preview } : {}) });

const actions = { open: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), share: vi.fn() };
const grid = (items: SyncItem[]) =>
  render(<FileGrid items={items} label="Files" selectedId={null} onSelect={vi.fn()} onOpen={vi.fn()} actions={actions} />);
const card = (name: string) => screen.getByText(name).closest('li')!;

it('a folder with a mosaic shows it (composite URL) with a folder badge once loaded', async () => {
  grid([folder('d_a', 'Fotos', { kind: 'none', thumbnail: true, thumbnailKey: 'abc' })]);
  const img = await waitFor(() => {
    const el = card('Fotos').querySelector('img');
    expect(el).not.toBeNull();
    return el!;
  });
  expect(img.getAttribute('src')).toBe('/api/sync/v1/items/d_a/thumbnail?size=256&composite=1&v=abc&dt=tok-d_a');
  expect(within(card('Fotos')).queryByTestId('folder-badge')).toBeNull(); // not before the image decoded
  img.dispatchEvent(new Event('load'));
  await waitFor(() => expect(within(card('Fotos')).getByTestId('folder-badge')).toBeInTheDocument());
});

it('a folder without a mosaic keeps its icon and requests nothing', async () => {
  grid([folder('d_b', 'Leer')]);
  await new Promise((r) => setTimeout(r, 10));
  expect(card('Leer').querySelector('img')).toBeNull();
  expect(card('Leer').querySelector('svg')).not.toBeNull();
  expect(apiMock).not.toHaveBeenCalled();
});
