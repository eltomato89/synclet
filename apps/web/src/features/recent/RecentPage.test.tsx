import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SPACES, syncItem, TEAM } from '@/test/spaces';
import { RecentPage } from './RecentPage';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows the space name next to files that are not in "My files"', async () => {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
    if (path === '/sync/v1/account') return { spaces: SPACES };
    if (path.startsWith('/sync/v1/recent')) {
      return [
        syncItem({ id: 'f_1', name: 'mine.txt', spaceId: 'personal' }),
        syncItem({ id: 'f_2', name: 'ours.txt', parentId: `r_${TEAM}`, spaceId: TEAM, modifiedAt: '2026-10-15T11:00:00Z' }),
      ];
    }
    if (path === '/sync/v1/capabilities') return { versions: false, office: { enabled: false, url: null } };
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
  const { wrapper: W } = testQueryClient();
  render(<W><MemoryRouter><RecentPage /></MemoryRouter></W>);
  const ours = (await screen.findByText('ours.txt')).closest('tr')!;
  expect(await within(ours).findByText('Familie')).toBeInTheDocument();
  const mine = screen.getByText('mine.txt').closest('tr')!;
  expect(within(mine).queryByText('My files')).toBeNull();
});
