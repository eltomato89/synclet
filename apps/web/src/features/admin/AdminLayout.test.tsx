import type { PublicUser, VersionInfoWire } from '@synclet/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/app-shell/Sidebar';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { AdminLayout, RequireAdmin } from './AdminLayout';
import { UPDATE_HINT_PENDING_MS } from './queries';

let me: PublicUser | null = null;
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: me, logout: async () => {} }) }));

const admin: PublicUser = { id: 'u1', username: 'root', displayName: 'Root', email: null, role: 'admin' };
const member: PublicUser = { ...admin, id: 'u2', username: 'anna', displayName: 'Anna', role: 'user' };

beforeAll(async () => { await i18n.changeLanguage('en'); });
beforeEach(() => {
  vi.spyOn(apiMod, 'api').mockImplementation(async () => ({ usedBytes: 0, quotaBytes: 0 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); me = null; });

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireAdmin />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route path="users" element={<p>user table</p>} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

it('shows the plain 404 page to non-admins', () => {
  me = member;
  renderAt('/admin/users');
  expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  expect(screen.queryByText('user table')).toBeNull();
  expect(screen.queryByRole('navigation', { name: 'Administration' })).toBeNull();
});

it('renders the admin area with its section tabs for admins', () => {
  me = admin;
  renderAt('/admin/users');
  expect(screen.getByText('user table')).toBeInTheDocument();
  const tabs = screen.getByRole('navigation', { name: 'Administration' });
  expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
  expect(tabs).toHaveTextContent('Sign-in');
});

it('lists "Administration" in the sidebar only for admins', () => {
  const { wrapper: Wrapper } = testQueryClient();
  me = member;
  const { unmount } = render(<Wrapper><MemoryRouter><Sidebar /></MemoryRouter></Wrapper>);
  expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
  unmount();
  me = admin;
  render(<Wrapper><MemoryRouter><Sidebar /></MemoryRouter></Wrapper>);
  expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute('href', '/admin');
});

function mockStatus(status: VersionInfoWire['status']) {
  const calls: string[] = [];
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
    calls.push(path);
    if (path === '/admin/status') {
      return { version: { installed: '0.1.2', revision: null, latest: '0.1.3', latestUrl: null, checkedAt: null, status } };
    }
    return { usedBytes: 0, quotaBytes: 0 };
  });
  return calls;
}

it('marks "Administration" in the sidebar when an update is available', async () => {
  const calls = mockStatus('update-available');
  const { wrapper: Wrapper } = testQueryClient();
  me = admin;
  const view = render(<Wrapper><MemoryRouter><Sidebar /></MemoryRouter></Wrapper>);
  const link = await screen.findByRole('link', { name: 'Administration Update available' });
  expect(within(link).getByTestId('update-dot')).toBeInTheDocument();
  // Rerenders reuse the cached status instead of asking the server again.
  view.rerender(<Wrapper><MemoryRouter><Sidebar /></MemoryRouter></Wrapper>);
  expect(calls.filter((p) => p === '/admin/status')).toHaveLength(1);
});

it('shows no update mark when up to date, and never asks for the status as a non-admin', async () => {
  const calls = mockStatus('up-to-date');
  const { wrapper: Wrapper } = testQueryClient();
  me = admin;
  const { unmount } = render(<Wrapper><MemoryRouter><Sidebar /></MemoryRouter></Wrapper>);
  await waitFor(() => expect(calls).toContain('/admin/status'));
  expect(screen.getByRole('link', { name: 'Administration' })).toBeInTheDocument();
  expect(screen.queryByTestId('update-dot')).toBeNull();
  unmount();

  const memberCalls = mockStatus('update-available');
  const second = testQueryClient();
  me = member;
  render(<second.wrapper><MemoryRouter><Sidebar /></MemoryRouter></second.wrapper>);
  await waitFor(() => expect(memberCalls).toContain('/sync/v1/account'));
  expect(memberCalls).not.toContain('/admin/status');
  expect(screen.queryByTestId('update-dot')).toBeNull();
});

it('asks again soon while the server has no update result yet', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let n = 0;
    vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
      if (path !== '/admin/status') return { usedBytes: 0, quotaBytes: 0 };
      n += 1;
      return n === 1
        ? { version: { installed: '0.1.2', revision: null, latest: null, latestUrl: null, checkedAt: null, status: 'checking' } }
        : { version: { installed: '0.1.2', revision: null, latest: '0.1.3', latestUrl: null, checkedAt: '2026-10-16T10:00:00Z', status: 'update-available' } };
    });
    const { wrapper: Wrapper } = testQueryClient();
    me = admin;
    render(<Wrapper><MemoryRouter><Sidebar /></MemoryRouter></Wrapper>);
    await waitFor(() => expect(n).toBe(1));
    expect(screen.queryByTestId('update-dot')).toBeNull();
    await vi.advanceTimersByTimeAsync(UPDATE_HINT_PENDING_MS);
    expect(await screen.findByTestId('update-dot')).toBeInTheDocument();
    // A result exists now: no more polling.
    await vi.advanceTimersByTimeAsync(UPDATE_HINT_PENDING_MS * 3);
    expect(n).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
