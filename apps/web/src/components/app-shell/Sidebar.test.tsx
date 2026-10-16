import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { markSpaceUnavailable } from '@/features/spaces/useSpaces';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { EXT, SPACES, TEAM } from '@/test/spaces';
import { Sidebar } from './Sidebar';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'kim', displayName: 'Kim', email: null, role: 'user' }, logout: async () => {} }),
}));

beforeAll(async () => { await i18n.changeLanguage('en'); });
let spaces = SPACES;
beforeEach(() => {
  spaces = SPACES;
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
    if (path === '/sync/v1/account') return { usedBytes: 0, quotaBytes: 0, canWrite: true, spaces };
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderAt(path: string) {
  const q = testQueryClient();
  render(<q.wrapper><MemoryRouter initialEntries={[path]}><Sidebar /></MemoryRouter></q.wrapper>);
  return q;
}

it('lists "My files", then a "Spaces" section with one entry per team folder and storage', async () => {
  renderAt('/files');
  const section = await screen.findByRole('navigation', { name: 'Spaces' });
  const links = within(section).getAllByRole('link');
  expect(links.map((l) => l.textContent)).toEqual([expect.stringContaining('Familie'), expect.stringContaining('NAS')]);
  expect(links[0]).toHaveAttribute('href', `/files/r_${TEAM}`);
  expect(links[1]).toHaveAttribute('href', `/files/r_${EXT}`);
  // The personal space stays "My files" in the main navigation.
  expect(within(section).queryByText('Meine Dateien')).toBeNull();
  expect(screen.getByRole('link', { name: 'My files' })).toHaveAttribute('aria-current', 'page');
});

it('marks read-only spaces with a lock', async () => {
  renderAt('/files');
  const nas = await screen.findByRole('link', { name: /NAS/ });
  expect(within(nas).getByLabelText('Read only')).toBeInTheDocument();
  expect(within(screen.getByRole('link', { name: /Familie/ })).queryByLabelText('Read only')).toBeNull();
});

it('highlights the space whose root is open, not "My files"', async () => {
  renderAt(`/files/r_${TEAM}`);
  expect(await screen.findByRole('link', { name: /Familie/ })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'My files' })).not.toHaveAttribute('aria-current');
});

it('shows "Not available" for a space that answered 503', async () => {
  const { qc } = renderAt('/files');
  await screen.findByRole('link', { name: /NAS/ });
  act(() => markSpaceUnavailable(qc, EXT, true));
  expect(await within(screen.getByRole('link', { name: /NAS/ })).findByText('Not available')).toBeInTheDocument();
});

it('has no spaces section when the account has only the personal space', async () => {
  spaces = SPACES.slice(0, 1);
  renderAt('/files');
  await screen.findByText(/used/);
  expect(screen.queryByRole('navigation', { name: 'Spaces' })).toBeNull();
});
