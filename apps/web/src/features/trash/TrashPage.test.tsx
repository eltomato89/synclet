import type { TrashEntryWire } from '@synclet/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SPACES, TEAM } from '@/test/spaces';
import { TrashPage } from './TrashPage';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: null, logout: async () => {} }) }));

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const entry = (id: string, name: string, originalPath: string, spaceId?: string): TrashEntryWire => ({
  id, itemId: `f_${id}`, type: 'file', name, originalPath, size: 1, deletedAt: '2026-10-15T10:00:00Z', expiresAt: null, itemCount: 1,
  ...(spaceId ? { spaceId } : {}),
});

function renderWith(entries: TrashEntryWire[]) {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
    if (path === '/sync/v1/account') return { spaces: SPACES };
    if (path === '/trash') return entries;
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
  const { wrapper: W } = testQueryClient();
  render(<W><MemoryRouter><TooltipProvider><TopbarProvider><Topbar onOpenNavigation={() => {}} /><TrashPage /></TopbarProvider></TooltipProvider></MemoryRouter></W>);
}

it('shows the space as the start of the original location', async () => {
  renderWith([entry('1', 'mine.txt', 'Docs/mine.txt'), entry('2', 'ours.txt', 'Belege/ours.txt', TEAM)]);
  const ours = (await screen.findAllByText('ours.txt'))[0].closest('tr')!;
  expect(await within(ours).findAllByText('Familie / Belege')).not.toHaveLength(0);
  const mine = screen.getAllByText('mine.txt')[0].closest('tr')!;
  expect(within(mine).getAllByText('My files / Docs')).not.toHaveLength(0);
});

it('"Empty trash" counts only "My files" (the server empties just the personal space)', async () => {
  renderWith([entry('1', 'mine.txt', 'mine.txt', 'personal'), entry('2', 'ours.txt', 'ours.txt', TEAM)]);
  await screen.findAllByText('ours.txt');
  screen.getByRole('button', { name: 'Empty trash' }).click();
  expect(await screen.findByText(/1 item is deleted for good/)).toBeInTheDocument();
});

it('offers no "Empty trash" when only other spaces have deleted items', async () => {
  renderWith([entry('2', 'ours.txt', 'ours.txt', TEAM)]);
  await screen.findAllByText('ours.txt');
  expect(screen.queryByRole('button', { name: 'Empty trash' })).toBeNull();
});
