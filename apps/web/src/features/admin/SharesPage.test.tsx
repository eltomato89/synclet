import type { AdminShareWire } from '@synclet/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SharesPage } from './SharesPage';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', username: 'root', displayName: 'Root', email: null, role: 'admin' } }) }));

const base = {
  itemType: 'file' as const, url: '', hasPassword: false, expiresAt: null, allowDownload: true, allowUpload: false,
  createdAt: '2026-10-01T10:00:00Z', revokedAt: null, hits: 0, itemTrashed: false, owner: { id: 'u2', username: 'anna' },
};
const shares: AdminShareWire[] = [
  { ...base, id: 's1', itemId: 'f_1', itemName: 'mine.txt', space: { id: 'u2', name: 'anna', kind: 'personal' } },
  { ...base, id: 's2', itemId: 'f_2', itemName: 'team.txt', space: { id: 't1', name: 'Familie', kind: 'shared' } },
  { ...base, id: 's3', itemId: 'f_3', itemName: 'nas.txt', space: { id: 'e1', name: 'NAS', kind: 'external' } },
];

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path) => {
    if (path.startsWith('/admin/shares')) return shares;
    if (path === '/admin/users') return [];
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the space of team folder and storage links; personal links leave it empty', async () => {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><MemoryRouter><TopbarProvider><Topbar onOpenNavigation={() => {}} /><SharesPage /></TopbarProvider></MemoryRouter></Wrapper>);
  const table = await screen.findByRole('table');
  expect(within(table).getByRole('columnheader', { name: 'Space' })).toBeInTheDocument();
  const cell = (name: string) => within(screen.getByText(name).closest('tr')!).getByTestId('share-space');
  expect(cell('team.txt')).toHaveTextContent('Familie');
  expect(cell('nas.txt')).toHaveTextContent('NAS');
  expect(cell('mine.txt')).toHaveTextContent('');
});
