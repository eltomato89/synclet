import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { ShareDialog } from './ShareDialog';

beforeAll(async () => {
  await i18n.changeLanguage('en');
  // Radix' Switch measures itself; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const created = {
  id: 's1', itemId: 'd_1', itemName: 'Fotos', itemType: 'folder', url: '/s/abcdefghijklmnopqrstuvwxyz', hasPassword: true,
  expiresAt: null, allowDownload: true, allowUpload: true, createdAt: '2026-10-15T10:00:00Z', revokedAt: null, hits: 0,
};

function setup() {
  const spy = vi.spyOn(apiMod, 'api').mockImplementation(async (path, init) => {
    if (path.startsWith('/shares?itemId=')) return [];
    if (path === '/shares' && init?.method === 'POST') return created;
    throw new Error(`unexpected ${path}`);
  });
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><ShareDialog open onOpenChange={() => {}} item={{ id: 'd_1', name: 'Fotos', type: 'folder' }} /></Wrapper>);
  return spy;
}
const posts = (spy: ReturnType<typeof setup>) => spy.mock.calls.filter(([, init]) => init?.method === 'POST');

it('opens the create form for an item without links and rejects short passwords and past dates', async () => {
  const spy = setup();
  const submit = await screen.findByRole('button', { name: 'Create link' });
  expect(spy).toHaveBeenCalledWith('/shares?itemId=d_1');

  fireEvent.click(screen.getByRole('switch', { name: /Password/ }));
  fireEvent.change(screen.getByLabelText('Password for the link'), { target: { value: 'abc' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Date' }));
  fireEvent.change(screen.getByLabelText('Expiry date'), { target: { value: '2020-01-01' } });
  fireEvent.click(submit);

  expect(await screen.findByText('The password needs at least 6 characters.')).toBeInTheDocument();
  expect(screen.getByText(/The date is in the past/)).toBeInTheDocument();
  expect(posts(spy)).toHaveLength(0);
});

it('creates a folder link with upload and shows the copyable URL', async () => {
  const spy = setup();
  const submit = await screen.findByRole('button', { name: 'Create link' });
  fireEvent.click(screen.getByRole('switch', { name: /Password/ }));
  fireEvent.change(screen.getByLabelText('Password for the link'), { target: { value: 'secret1' } });
  fireEvent.click(screen.getByRole('switch', { name: /Allow upload/ }));
  fireEvent.click(submit);

  await waitFor(() => expect(posts(spy)).toHaveLength(1));
  expect(posts(spy)[0][1]).toMatchObject({ json: { itemId: 'd_1', password: 'secret1', expiresAt: null, allowDownload: true, allowUpload: true } });
  expect(await screen.findByDisplayValue(`${window.location.origin}/s/abcdefghijklmnopqrstuvwxyz`)).toBeInTheDocument();
});
