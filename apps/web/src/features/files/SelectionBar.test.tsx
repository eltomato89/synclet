import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import i18n from '@/lib/i18n';
import { syncItem } from '@/test/spaces';
import { bulkCaps } from './bulk';
import { SelectionBar } from './SelectionBar';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);
const actions = () => ({ download: vi.fn(), copy: vi.fn(), move: vi.fn(), remove: vi.fn() });

it('offers the bulk actions and clears', () => {
  const a = actions(); const onClear = vi.fn();
  render(<TooltipProvider><SelectionBar count={3} caps={{ move: true, delete: true }} actions={a} onClear={onClear} /></TooltipProvider>);
  expect(screen.getByText('3 selected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Download (ZIP)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move …' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
  expect([a.download, a.copy, a.move, a.remove, onClear].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1, 1]);
});

it('disables move and delete when not every item allows them', () => {
  const caps = bulkCaps([syncItem({ id: 'f_1', name: 'a' }), syncItem({ id: 'f_2', name: 'b' }, true)]);
  expect(caps).toEqual({ move: false, delete: false });
  const a = actions();
  render(<TooltipProvider><SelectionBar count={2} caps={caps} actions={a} onClear={() => {}} /></TooltipProvider>);
  expect(screen.getByRole('button', { name: 'Move …' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
});
