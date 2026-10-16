import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { syncItem, TEAM } from '@/test/spaces';
import { Breadcrumbs } from './Breadcrumbs';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

const folder = (id: string, name: string, parentId: string) => syncItem({ id, name, parentId, type: 'folder', kind: 'folder' });

it('starts with "My files" in the personal space', () => {
  const chain = [syncItem({ id: 'root', name: '', parentId: null, type: 'folder', kind: 'root' }), folder('d_1', 'Fotos', 'root')];
  render(<MemoryRouter><Breadcrumbs chain={chain} /></MemoryRouter>);
  expect(screen.getAllByRole('link', { name: 'My files' })[0]).toHaveAttribute('href', '/files');
});

it('starts with the space name in a team folder', () => {
  const root = syncItem({ id: `r_${TEAM}`, name: 'Familie', parentId: null, type: 'folder', kind: 'root', spaceId: TEAM });
  const chain = [root, { ...folder('d_2', 'Urlaub', root.id), spaceId: TEAM }];
  render(<MemoryRouter><Breadcrumbs chain={chain} /></MemoryRouter>);
  expect(screen.getAllByRole('link', { name: 'Familie' })[0]).toHaveAttribute('href', `/files/r_${TEAM}`);
  expect(screen.queryByText('My files')).toBeNull();
});

it('shows the space name as the current page at a space root', () => {
  const root = syncItem({ id: `r_${TEAM}`, name: 'Familie', parentId: null, type: 'folder', kind: 'root', spaceId: TEAM });
  render(<MemoryRouter><Breadcrumbs chain={[root]} /></MemoryRouter>);
  expect(screen.getByText('Familie')).toHaveAttribute('aria-current', 'page');
});
