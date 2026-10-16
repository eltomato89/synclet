import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { ApiError } from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { GroupsPage } from './GroupsPage';
import { MembersEditor } from './MembersEditor';
import { SpacesPage } from './SpacesPage';
import type { GroupWire, SpaceWire } from './types';
import { useState } from 'react';
import type { MemberRow } from './forms';

vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { id: 'u0', username: 'root', displayName: 'Root', email: null, role: 'admin' } }) }));

const anna = { id: 'u1', username: 'anna', displayName: 'Anna A' };
const ben = { id: 'u2', username: 'ben', displayName: 'Ben B' };
const users = [anna, ben].map((u) => ({ ...u, email: null, role: 'user', disabled: false, createdAt: '2026-10-01T10:00:00Z', lastLoginAt: null, identities: [], usedBytes: 0, devices: 0 }));
const group: GroupWire = { id: 'g1', name: 'Marketing', members: [anna] };
const team: SpaceWire = {
  id: 's1', kind: 'team', name: 'Projekte', rootPath: '/teams/Projekte', status: 'available', readOnly: false, watch: 'auto',
  scanIntervalSec: null, sizeBytes: 2048, itemCount: 3, members: [{ kind: 'group', id: 'g1', name: 'Marketing', role: 'write' }],
};
const gone: SpaceWire = { ...team, id: 's3', name: 'Alt', rootPath: '/teams/Alt', status: 'ignored', members: [] };
const ext: SpaceWire = {
  id: 's2', kind: 'external', name: 'nas', rootPath: '/storage/nas', status: 'missing', readOnly: true, watch: 'auto',
  scanIntervalSec: 600, sizeBytes: 0, itemCount: 0, members: [],
};

let postError: unknown = null;
let calls: { path: string; init?: RequestInit & { json?: unknown } }[] = [];
beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  calls = [];
  postError = null;
  vi.spyOn(apiMod, 'api').mockImplementation(async (path, init) => {
    calls.push({ path, init: init as never });
    const method = init?.method ?? 'GET';
    if (path === '/admin/users') return users;
    if (path === '/admin/groups' && method === 'GET') return [group];
    if (path === '/admin/spaces' && method === 'GET') return [team, ext, gone];
    if (postError && method === 'POST') throw postError;
    return {};
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderPage(el: React.ReactNode) {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><MemoryRouter><TopbarProvider><Topbar onOpenNavigation={() => {}} />{el}</TopbarProvider></MemoryRouter></Wrapper>);
}
const sent = (method: string) => calls.find((c) => c.init?.method === method);

it('members editor adds, removes and re-roles rows', () => {
  const seen: MemberRow[][] = [];
  function Host() {
    const [v, setV] = useState<MemberRow[]>([]);
    return <MembersEditor value={v} onChange={(n) => { seen.push(n); setV(n); }} users={[anna, ben]} groups={[{ id: 'g1', name: 'Marketing' }]} />;
  }
  render(<Host />);
  fireEvent.change(screen.getByLabelText('Add member'), { target: { value: 'group:g1' } });
  fireEvent.change(screen.getByLabelText('Add member'), { target: { value: 'user:u2' } });
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Access for Ben B'), { target: { value: 'write' } });
  expect(seen.at(-1)).toEqual([
    { kind: 'group', id: 'g1', name: 'Marketing', role: 'read' },
    { kind: 'user', id: 'u2', name: 'Ben B', role: 'write' },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Marketing' }));
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  // Already added members are no longer offered.
  expect(within(screen.getByLabelText('Add member')).queryByRole('option', { name: 'Ben B' })).toBeNull();
});

it('creates a group after validating its name', async () => {
  renderPage(<GroupsPage />);
  expect(await screen.findByText('Marketing')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New group' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
  expect(within(dialog).getByText('Enter a name.')).toBeInTheDocument();
  expect(sent('POST')).toBeUndefined();
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'a/b' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
  expect(within(dialog).getByText(/can't be used as a name/)).toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Vertrieb' } });
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Ben B/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }));
  await waitFor(() => expect(sent('POST')).toBeDefined());
  expect(sent('POST')).toMatchObject({ path: '/admin/groups', init: { json: { name: 'Vertrieb', memberIds: ['u2'] } } });
});

it('lists spaces with status, read-only badge and members; external ones link to the docs', async () => {
  renderPage(<SpacesPage />);
  const row = (await screen.findByText('Projekte')).closest('tr')!;
  expect(within(row).getByText('/teams/Projekte')).toBeInTheDocument();
  expect(within(row).getByText('Available')).toBeInTheDocument();
  expect(within(row).getByText('2 KB')).toBeInTheDocument();
  const ext = screen.getByText('nas').closest('tr')!;
  expect(within(ext).getByText('Unavailable')).toBeInTheDocument();
  expect(within(ext).getByText('Read only')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /mount/i })).toHaveAttribute('href', expect.stringContaining('deploy/README.md#team-folders-and-external-storage'));
});

it('edits a team folder: rename and member list in one PATCH', async () => {
  renderPage(<SpacesPage />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for Projekte' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Projekte neu' } });
  fireEvent.change(within(dialog).getByLabelText('Add member'), { target: { value: 'user:u1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(sent('PATCH')).toBeDefined());
  expect(sent('PATCH')).toMatchObject({
    path: '/admin/spaces/s1',
    init: { json: { name: 'Projekte neu', members: [{ kind: 'group', id: 'g1', role: 'write' }, { kind: 'user', id: 'u1', role: 'read' }] } },
  });
});

it('external storage edit has no name field but watch mode and scan interval', async () => {
  renderPage(<SpacesPage />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for nas' }), { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'Remove' })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByLabelText('Name')).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Watch mode'), { target: { value: 'off' } });
  fireEvent.change(within(dialog).getByLabelText('Scan interval (seconds)'), { target: { value: '120' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(sent('PATCH')).toBeDefined());
  expect(sent('PATCH')?.init?.json).toEqual({ watch: 'off', scanIntervalSec: 120, members: [] });
});

it('scans a space and removes a team folder after confirming that the folder stays', async () => {
  renderPage(<SpacesPage />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for Projekte' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Scan now' }));
  await waitFor(() => expect(sent('POST')?.path).toBe('/admin/spaces/s1/scan'));
  fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for Projekte' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('The folder stays on disk.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove folder' }));
  await waitFor(() => expect(sent('DELETE')?.path).toBe('/admin/spaces/s1'));
});

it('creates a team folder', async () => {
  renderPage(<SpacesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'New team folder' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Buchhaltung' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create team folder' }));
  await waitFor(() => expect(sent('POST')).toBeDefined());
  expect(sent('POST')).toMatchObject({ path: '/admin/spaces', init: { json: { name: 'Buchhaltung' } } });
});

it('creates a team folder with its members in one POST; a failed POST can be retried', async () => {
  postError = new ApiError(409, 'conflict', 'exists');
  renderPage(<SpacesPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'New team folder' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Neu' } });
  await within(dialog).findByRole('option', { name: 'Marketing' });
  fireEvent.change(within(dialog).getByLabelText('Add member'), { target: { value: 'group:g1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create team folder' }));
  expect(await within(dialog).findByText('That name is already in use.')).toBeInTheDocument();
  postError = null;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create team folder' }));
  await waitFor(() => expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(2));
  const posts = calls.filter((c) => c.init?.method === 'POST');
  for (const p of posts) expect(p.init?.json).toEqual({ name: 'Neu', members: [{ kind: 'group', id: 'g1', role: 'read' }] });
  expect(sent('PATCH')).toBeUndefined();
});

it('sends only the changed external settings', async () => {
  renderPage(<SpacesPage />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for nas' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Scan interval (seconds)'), { target: { value: '30' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(sent('PATCH')).toBeDefined());
  expect(sent('PATCH')?.init?.json).toEqual({ scanIntervalSec: 30, members: [] });
});

it('hides edit and scan for removed spaces and restores them', async () => {
  renderPage(<SpacesPage />);
  const row = (await screen.findByText('Alt')).closest('tr')!;
  expect(within(row).getByText('Hidden')).toBeInTheDocument();
  fireEvent.keyDown(within(row).getByRole('button', { name: 'Actions for Alt' }), { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Restore']);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Restore' }));
  await waitFor(() => expect(sent('POST')?.path).toBe('/admin/spaces/s3/restore'));
});

it('removes an external storage with the hide-in-Synclet confirmation', async () => {
  renderPage(<SpacesPage />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for nas' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('The space is hidden in Synclet. The folder stays on disk.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove folder' }));
  await waitFor(() => expect(sent('DELETE')?.path).toBe('/admin/spaces/s2'));
});

it('requires a scan interval of at least 10 seconds', async () => {
  renderPage(<SpacesPage />);
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for nas' }), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Scan interval (seconds)'), { target: { value: '5' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(within(dialog).getByText(/10 or more/)).toBeInTheDocument();
  expect(sent('PATCH')).toBeUndefined();
});
