import type { PublicUser } from '@synclet/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/app-shell/Sidebar';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { AdminLayout, RequireAdmin } from './AdminLayout';

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
