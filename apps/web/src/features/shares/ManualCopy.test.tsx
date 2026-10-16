import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import * as apiMod from '@/lib/api';
import { testQueryClient } from '@/test/query';
import { SharedPage } from './SharedPage';
import { ShareDialog } from './ShareDialog';

const share = {
  id: 's1', itemId: 'f_1', itemName: 'Rechnung.pdf', itemType: 'file', url: '/s/tok123', hasPassword: false,
  expiresAt: null, allowDownload: true, allowUpload: false, createdAt: '2026-10-15T10:00:00Z', revokedAt: null, hits: 3, itemTrashed: false,
};
const URL_ABS = `${window.location.origin}/s/tok123`;
const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeAll(async () => {
  await i18n.changeLanguage('en');
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  // Both copy paths fail: no async clipboard (plain http) and execCommand refuses.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
  vi.spyOn(apiMod, 'api').mockImplementation(async (path) => {
    if (path === '/shares' || path.startsWith('/shares?itemId=')) return [share];
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.restoreAllMocks();
});

async function expectManualCopy() {
  const dialog = await screen.findByRole('dialog', { name: 'Copy the link' });
  const field = screen.getByDisplayValue<HTMLInputElement>(URL_ABS);
  expect(dialog).toContainElement(field);
  expect(field).toHaveAttribute('readonly');
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)).toBe(URL_ABS);
}

it('offers the selected URL for manual copying from the shared links page', async () => {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><MemoryRouter><SharedPage /></MemoryRouter></Wrapper>);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy link to Rechnung.pdf' }));
  await expectManualCopy();
});

it('offers the selected URL for manual copying from a link row in the share dialog', async () => {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><ShareDialog open onOpenChange={() => {}} item={{ id: 'f_1', name: 'Rechnung.pdf', type: 'file' }} /></Wrapper>);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
  await expectManualCopy();
});
