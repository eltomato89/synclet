import type { SyncItem } from '@synclet/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Topbar, TopbarProvider } from '@/components/app-shell/Topbar';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { EXT, SPACES, syncItem, TEAM } from '@/test/spaces';
import { FilesPage } from './FilesPage';

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'lu', displayName: 'Lu', email: null, role: 'user' }, logout: async () => {} }),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});

let folders: Record<string, { folder: SyncItem; items: SyncItem[] } | apiMod.ApiError> = {};
beforeEach(() => {
  vi.spyOn(apiMod, 'api').mockImplementation(async (path: string) => {
    if (path === '/sync/v1/account') return { canWrite: true, usedBytes: 0, quotaBytes: 0, maxUploadBytes: 0, spaces: SPACES };
    if (path === '/sync/v1/capabilities') return { versions: false, office: { enabled: false, url: null } };
    const m = /^\/sync\/v1\/items\/([^/?]+)(\/children)?/.exec(path);
    const f = m ? folders[m[1]] : undefined;
    if (f instanceof apiMod.ApiError) throw f;
    if (f) return m![2] ? { items: f.items, nextPageToken: null, cursor: '1' } : f.folder;
    throw new apiMod.ApiError(404, 'not_found', 'x');
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); folders = {}; });

function renderAt(path: string) {
  const q = testQueryClient();
  render(
    <q.wrapper>
      <MemoryRouter initialEntries={[path]}>
        <TooltipProvider><TopbarProvider>
          <Topbar onOpenNavigation={() => {}} />
          <Routes>
            <Route path="/files" element={<FilesPage />} />
            <Route path="/files/:folderId" element={<FilesPage />} />
          </Routes>
        </TopbarProvider></TooltipProvider>
      </MemoryRouter>
    </q.wrapper>,
  );
  return q;
}

const root = (space: string, name: string, readOnly: boolean) =>
  syncItem({ id: `r_${space}`, name, parentId: null, type: 'folder', kind: 'root', spaceId: space,
    capabilities: { read: true, write: false, rename: false, move: false, delete: false, addChildren: !readOnly } });

it('hides upload and new in a read-only space and shows the "Read only" banner', async () => {
  folders[`r_${EXT}`] = { folder: root(EXT, 'NAS', true), items: [syncItem({ id: 'f_1', name: 'scan.pdf', parentId: `r_${EXT}`, spaceId: EXT }, true)] };
  renderAt(`/files/r_${EXT}`);
  expect(await screen.findByText('scan.pdf')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Read only' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  // Breadcrumb root is the space name.
  expect(screen.getAllByText('NAS').length).toBeGreaterThan(0);
});

it('keeps upload and new in a writable space, without the banner', async () => {
  folders[`r_${TEAM}`] = { folder: root(TEAM, 'Familie', false), items: [syncItem({ id: 'f_2', name: 'liste.txt', parentId: `r_${TEAM}`, spaceId: TEAM })] };
  renderAt(`/files/r_${TEAM}`);
  expect(await screen.findByText('liste.txt')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'New' })).toBeEnabled();
  expect(screen.queryByRole('status', { name: 'Read only' })).toBeNull();
});

it('explains an unavailable space (503) instead of a generic load error', async () => {
  folders[`r_${EXT}`] = new apiMod.ApiError(503, 'space_unavailable', 'missing');
  const { qc } = renderAt(`/files/r_${EXT}`);
  expect(await screen.findByRole('heading', { name: 'This space is not available' })).toBeInTheDocument();
  // The sidebar learns about it.
  expect(qc.getQueryData(['spaces', 'unavailable'])).toEqual([EXT]);
});

it('an empty read-only folder offers no upload', async () => {
  folders[`r_${EXT}`] = { folder: root(EXT, 'NAS', true), items: [] };
  renderAt(`/files/r_${EXT}`);
  expect(await screen.findByText('Nothing here yet. You can only read in this space.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull();
});
