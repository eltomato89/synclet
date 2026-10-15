import type { ShareLinkWire } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { SharedPage } from './SharedPage';

const base: ShareLinkWire = {
  id: 's1', itemId: 'd_1', itemName: 'Urlaub', itemType: 'folder', url: '/s/tok123', hasPassword: false,
  expiresAt: null, allowDownload: true, allowUpload: false, createdAt: '2026-10-15T10:00:00Z', revokedAt: null, hits: 3,
  itemTrashed: false,
};
const trashed: ShareLinkWire = { ...base, id: 's2', itemId: 'd_2', itemName: 'Alt', url: '/s/tok456', itemTrashed: true };

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path) => {
    if (path === '/shares') return [base, trashed];
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderPage() {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><MemoryRouter><SharedPage /></MemoryRouter></Wrapper>);
}

const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

it('marks links of trashed items and only offers revoking them', async () => {
  await i18n.changeLanguage('en');
  renderPage();
  await screen.findByText('Alt');
  const row = rowOf('Alt');
  expect(within(row).getByText('In trash')).toBeInTheDocument();
  expect(within(row).getByText(/restoring it re-activates the link/)).toBeInTheDocument();
  expect(within(row).queryByRole('link', { name: 'Alt' })).toBeNull(); // folder link would lead nowhere
  expect(within(row).getByRole('button', { name: 'Copy link to Alt' })).toBeDisabled();
  fireEvent.keyDown(within(row).getByRole('button', { name: 'Link actions for Alt' }), { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Revoke link']);

  const live = rowOf('Urlaub');
  expect(within(live).queryByText('In trash')).toBeNull();
  expect(within(live).getByRole('link', { name: 'Urlaub' })).toBeInTheDocument();
  expect(within(live).getByRole('button', { name: 'Copy link to Urlaub' })).toBeEnabled();
});

it('shows the trash badge in German', async () => {
  await i18n.changeLanguage('de');
  renderPage();
  await screen.findByText('Alt');
  expect(within(rowOf('Alt')).getByText('Im Papierkorb')).toBeInTheDocument();
  await i18n.changeLanguage('en');
});
