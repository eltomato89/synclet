import type { SearchHit, SearchResponse, SyncItem } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { CommandPalette, stepActive } from './CommandPalette';
import { addRecentSearch, readRecentSearches } from './queries';

beforeAll(async () => { await i18n.changeLanguage('en'); });
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const item = (id: string, name: string, type: 'file' | 'folder' = 'file', parentId = 'd_p') =>
  ({ id, name, type, kind: type, parentId, mime: null, size: 1, modifiedAt: '2026-01-01T00:00:00Z' }) as SyncItem;
const hit = (it: SyncItem, matched: SearchHit['matched'], path = 'Projekte', snippet: string | null = null): SearchHit => ({ item: it, path, snippet, matched });

const HITS: SearchHit[] = [
  hit(item('f_content', 'notes.txt'), 'content', '', 'die «Rechnung» vom März'),
  hit(item('d_folder', 'Rechnungen', 'folder', 'root'), 'name', ''),
  hit(item('f_both', 'Rechnung-2024.pdf'), 'both', 'Projekte/2024', '«Rechnung» Nr. 7'),
];

function Location() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function setup(response: () => Promise<SearchResponse> = async () => ({ hits: HITS, total: 3 }), scope: { id: string; name: string } | null = null) {
  const api = vi.spyOn(apiMod, 'api').mockImplementation(async (path) => {
    if (path.startsWith('/sync/v1/search?')) return response();
    throw new Error(`unexpected ${path}`);
  });
  const onOpenChange = vi.fn();
  const { wrapper: Wrapper } = testQueryClient();
  render(
    <Wrapper>
      <MemoryRouter initialEntries={['/files']}>
        <Routes><Route path="*" element={<><CommandPalette open onOpenChange={onOpenChange} scope={scope} userId="u1" /><Location /></>} /></Routes>
      </MemoryRouter>
    </Wrapper>,
  );
  const input = screen.getByRole('combobox');
  return { api, input, onOpenChange };
}

const activeOption = (input: HTMLElement) => {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

describe('stepActive', () => {
  it('wraps around and starts at the ends', () => {
    expect(stepActive(-1, 1, 3)).toBe(0);
    expect(stepActive(-1, -1, 3)).toBe(2);
    expect(stepActive(2, 1, 3)).toBe(0);
    expect(stepActive(0, -1, 3)).toBe(2);
    expect(stepActive(0, 1, 0)).toBe(-1);
  });
});

describe('CommandPalette', () => {
  it('groups name and content hits and walks them with the arrow keys in visual order', async () => {
    const { input, api } = setup();
    fireEvent.change(input, { target: { value: 'rechnung' } });
    await screen.findByRole('group', { name: 'Names' });
    expect(api).toHaveBeenCalledWith('/sync/v1/search?q=rechnung&limit=30', expect.anything());

    const names = screen.getByRole('group', { name: 'Names' });
    const contents = screen.getByRole('group', { name: 'Contents' });
    expect(names.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(contents.querySelectorAll('[role="option"]')).toHaveLength(1);

    // First option is active: the folder (names group comes first).
    expect(activeOption(input)).toHaveTextContent('Rechnungen');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toHaveTextContent('Rechnung-2024.pdf');
    expect(activeOption(input)).toHaveTextContent('My files');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toHaveTextContent('notes.txt');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)).toHaveTextContent('Rechnungen'); // wraps
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption(input)).toHaveTextContent('notes.txt');
    expect(activeOption(input)).toHaveAttribute('aria-selected', 'true');
    expect(activeOption(input)?.querySelector('mark')).toHaveTextContent('Rechnung');
  });

  it('Enter on a file opens its folder with the file to preview and remembers the search', async () => {
    const { input, onOpenChange } = setup();
    fireEvent.change(input, { target: { value: 'rechnung' } });
    await screen.findByRole('group', { name: 'Names' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent('/files/d_p?preview=f_both');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(readRecentSearches('u1')).toEqual(['rechnung']);
  });

  it('ignores Enter while the shown hits belong to the previous query', async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'rechnung' } });
    await screen.findByRole('group', { name: 'Names' });
    fireEvent.change(input, { target: { value: 'rechnung 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/files$/);
  });

  it('Enter on a folder opens the folder', async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'rechnung' } });
    await screen.findByRole('group', { name: 'Names' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/files\/d_folder$/);
  });

  it('shows recent searches for an empty query; choosing one searches again', async () => {
    addRecentSearch('u1', 'older');
    addRecentSearch('u1', 'budget');
    const { input, api } = setup();
    const group = screen.getByRole('group', { name: 'Recent searches' });
    expect(Array.from(group.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual(['budget', 'older']);
    expect(input).not.toHaveAttribute('aria-activedescendant');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('budget');
    await waitFor(() => expect(api).toHaveBeenCalledWith('/sync/v1/search?q=budget&limit=30', expect.anything()));
  });

  it('shows the no-results and error states', async () => {
    let fail = false;
    const { input } = setup(async () => {
      if (fail) throw new apiMod.ApiError(0, 'network', 'offline');
      return { hits: [], total: 0 };
    });
    fireEvent.change(input, { target: { value: 'zzz' } });
    const notice = await screen.findByText('Nothing found for “zzz”');
    expect(notice.closest('[role="listbox"]')).toBeNull(); // notices are not options
    expect(input).not.toHaveAttribute('aria-controls');
    fail = true;
    fireEvent.change(input, { target: { value: 'yyy' } });
    expect(await screen.findByText('Search didn’t work')).toBeInTheDocument();
  });

  it('limits the search to the current folder when asked', async () => {
    const { input, api } = setup(undefined, { id: 'd_cur', name: 'Fotos' });
    fireEvent.click(screen.getByRole('button', { name: '“Fotos”' }));
    expect(screen.getByRole('button', { name: '“Fotos”' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(input, { target: { value: 'urlaub' } });
    await waitFor(() => expect(api).toHaveBeenCalledWith('/sync/v1/search?q=urlaub&limit=30&folder=d_cur', expect.anything()));
  });
});

describe('CommandPalette in spaces', () => {
  it('shows the space name as the location of hits outside "My files"', async () => {
    const { SPACES, TEAM } = await import('@/test/spaces');
    vi.spyOn(apiMod, 'api').mockImplementation(async (path) => {
      if (path === '/sync/v1/account') return { spaces: SPACES };
      if (path.startsWith('/sync/v1/search?')) {
        return { hits: [hit({ ...item('f_team', 'Rechnung-2025.pdf', 'file', `r_${TEAM}`), spaceId: TEAM }, 'name', 'Belege')], total: 1 };
      }
      throw new Error(`unexpected ${path}`);
    });
    const { wrapper: Wrapper } = testQueryClient();
    render(
      <Wrapper>
        <MemoryRouter initialEntries={['/files']}>
          <CommandPalette open onOpenChange={() => {}} scope={null} userId="u1" />
        </MemoryRouter>
      </Wrapper>,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rechnung' } });
    const option = await screen.findByRole('option', { name: /Rechnung-2025/ });
    await waitFor(() => expect(option).toHaveTextContent('Familie'));
    expect(option).toHaveTextContent('Belege');
    expect(option).not.toHaveTextContent('My files');
  });
});
