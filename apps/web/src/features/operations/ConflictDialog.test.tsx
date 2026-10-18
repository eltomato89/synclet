import type { SyncOperation } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { ConflictDialog } from './ConflictDialog';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

const op = (canReplace: boolean): SyncOperation => ({
  id: 'o1', kind: 'copy', status: 'waiting', targetId: 'd_t', targetName: 'Tausch', itemCount: 2, totalItems: 2, doneItems: 0,
  totalBytes: 3000, doneBytes: 0, results: [], error: null, createdAt: '2026-10-18T10:00:00Z', finishedAt: null,
  conflict: { sourceId: 'f_a', name: 'Bericht.docx', canReplace, source: { type: 'file', size: 2048, modifiedAt: '2026-10-18T09:00:00Z' }, existing: { id: 'f_x', type: 'file', size: 1024, modifiedAt: '2026-10-01T09:00:00Z' } },
});

it('shows both sides and resolves with "apply to all"', async () => {
  const onResolve = vi.fn(async () => {});
  render(<ConflictDialog op={op(true)} open onOpenChange={() => {}} onResolve={onResolve} onCancelOperation={async () => {}} />);
  expect(screen.getByRole('heading', { name: '“Bericht.docx” already exists in “Tausch”' })).toBeInTheDocument();
  expect(screen.getByText('2 KB')).toBeInTheDocument();
  expect(screen.getByText('1 KB')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Do this for all remaining conflicts' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));
  await waitFor(() => expect(onResolve).toHaveBeenCalledWith('keepBoth', true));
});

it('offers no "Replace" when the existing item cannot be replaced; cancel stops the operation', async () => {
  const onCancel = vi.fn(async () => {});
  render(<ConflictDialog op={op(false)} open onOpenChange={() => {}} onResolve={async () => {}} onCancelOperation={onCancel} />);
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel operation' }));
  await waitFor(() => expect(onCancel).toHaveBeenCalled());
});
