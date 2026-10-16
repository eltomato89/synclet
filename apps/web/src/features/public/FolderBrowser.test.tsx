import type { PublicShareEntry } from '@synclet/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { FolderBrowser } from './FolderBrowser';

const TOKEN = 'tok';
beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } });

const entries: PublicShareEntry[] = [
  { id: 'd_1', name: 'Fotos', type: 'folder', size: 0, mime: null, modifiedAt: '2026-10-01T10:00:00Z', hasThumbnail: true },
  { id: 'd_2', name: 'Leer', type: 'folder', size: 0, mime: null, modifiedAt: '2026-10-01T10:00:00Z', hasThumbnail: false },
];
const browse = (view: 'grid' | 'list') => {
  localStorage.setItem('synclet.publicShare.view', view);
  render(
    <FolderBrowser token={TOKEN} trail={[{ id: null, name: 'Share' }]} items={entries} loading={false} error={null}
      allowDownload={false} emptyHint={null} onNavigate={vi.fn()} onOpen={vi.fn()} onRetry={vi.fn()} />,
  );
};
const tile = (name: string) => screen.getByText(name).closest('li')!;

it('grid: a folder with pictures shows its mosaic with a folder badge; others keep the icon', () => {
  browse('grid');
  const img = tile('Fotos').querySelector('img')!;
  expect(img.getAttribute('src')).toBe(`/api/public/shares/${TOKEN}/items/d_1/thumbnail?size=256`);
  expect(tile('Fotos').querySelector('[data-testid="folder-badge"]')).not.toBeNull();
  expect(tile('Leer').querySelector('img')).toBeNull();
  // A failed image falls back to the folder icon.
  fireEvent.error(img);
  expect(tile('Fotos').querySelector('img')).toBeNull();
});

it('list: folders keep their icon', () => {
  browse('list');
  expect(tile('Fotos').querySelector('img')).toBeNull();
});
