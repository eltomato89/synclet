import type { AdminUserWire, PublicUser } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { ApiError } from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { UsersPage } from './UsersPage';

const me: PublicUser = { id: 'u1', username: 'root', displayName: 'Root', email: null, role: 'admin' };
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: me }) }));

const base = { disabled: false, createdAt: '2026-10-01T10:00:00Z', lastLoginAt: null, usedBytes: 2048, devices: 1 };
const root: AdminUserWire = { ...me, ...base, identities: [{ provider: 'local', subject: 'root' }] };
const boss: AdminUserWire = {
  id: 'u2', username: 'boss', displayName: 'Boss', email: 'boss@example.com', role: 'admin', ...base,
  identities: [{ provider: 'oidc:https://idp.example.com', subject: 'abc' }],
};

let calls: { path: string; init?: RequestInit & { json?: unknown } }[] = [];
let patchError: unknown = null;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  calls = [];
  patchError = null;
  vi.spyOn(apiMod, 'api').mockImplementation(async (path, init) => {
    calls.push({ path, init: init as never });
    if (path === '/admin/users' && !init?.method) return [root, boss];
    if (path === '/admin/folders/unassigned') return [{ name: 'Altbestand' }, { name: 'familie' }];
    if (path === '/admin/users' && init?.method === 'POST') return { ...root, id: 'u3' };
    if (path.startsWith('/admin/users/') && (init?.method === 'PATCH' || init?.method === 'DELETE')) {
      if (patchError) throw patchError;
      return boss;
    }
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderPage() {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><MemoryRouter><TopbarProvider><Topbar onOpenNavigation={() => {}} /><UsersPage /></TopbarProvider></MemoryRouter></Wrapper>);
}

async function openMenu(name: string) {
  fireEvent.keyDown(await screen.findByRole('button', { name: `Actions for ${name}` }), { key: 'Enter' });
  return screen.findByRole('menu');
}

it('lists users with role, storage and sign-in methods; no disable/delete for yourself', async () => {
  renderPage();
  const row = (await screen.findByRole('link', { name: 'Boss' })).closest('tr')!;
  expect(within(row).getByText('Administrator')).toBeInTheDocument();
  expect(within(row).getByText('2 KB')).toBeInTheDocument();
  expect(within(row).getByText('OIDC')).toBeInTheDocument();
  const menu = await openMenu('Root');
  expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Edit', 'Sessions and devices']);
});

it('shows the last-admin conflict inline in the edit dialog', async () => {
  patchError = new ApiError(409, 'conflict', 'last admin');
  renderPage();
  fireEvent.click(within(await openMenu('Boss')).getByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('radio', { name: 'User' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('last administrator who can sign in with a password');
  // Only the role changed, so nothing else is sent.
  const patch = calls.find((c) => c.init?.method === 'PATCH')!;
  expect(patch.path).toBe('/admin/users/u2');
  expect(patch.init?.json).toEqual({ role: 'user' });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('shows the last-admin conflict inline when deleting, and explains the folder stays', async () => {
  patchError = new ApiError(409, 'conflict', 'last admin');
  renderPage();
  fireEvent.click(within(await openMenu('Boss')).getByRole('menuitem', { name: 'Delete' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('/data/boss and its files stay on the server');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('last administrator');
});

it('validates the create form before sending anything', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'New user' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));
  expect(within(dialog).getByText('Enter a display name.')).toBeInTheDocument();
  expect(within(dialog).getByText('Enter a username.')).toBeInTheDocument();
  expect(within(dialog).getByText('Enter a password.')).toBeInTheDocument();
  expect(within(dialog).getByLabelText('Display name')).toHaveAttribute('aria-invalid', 'true');
  expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
});

it('creates a user from an unassigned folder', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'New user' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('switch', { name: 'Use an existing folder' }));
  fireEvent.click(await within(dialog).findByRole('radio', { name: 'Altbestand' }));
  expect(within(dialog).getByLabelText('Display name')).toHaveValue('Altbestand');
  expect(within(dialog).queryByLabelText('Username')).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'long enough pw' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
  expect(calls.find((c) => c.init?.method === 'POST')!.init?.json).toEqual({
    username: 'Altbestand', displayName: 'Altbestand', email: null, password: 'long enough pw', role: 'user', adoptExistingFolder: true,
  });
});

it('does not call an unmapped 409 in the user dialog "name taken"', async () => {
  patchError = new ApiError(409, 'conflict', 'something else');
  renderPage();
  fireEvent.click(within(await openMenu('Boss')).getByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Boss 2' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('That name is already in use.')).toBeNull();
});
