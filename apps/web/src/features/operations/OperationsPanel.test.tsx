import type { SyncOperation } from '@synclet/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';

const state = { operations: [] as { op: SyncOperation; visible: boolean; conflictOpen: boolean }[], offline: false };
const cancel = vi.fn(async () => {}); const dismiss = vi.fn(); const setConflictOpen = vi.fn();
vi.mock('./OperationsProvider', () => ({
  useOperations: () => ({ ...state, cancel, dismiss, setConflictOpen, resolve: vi.fn(async () => {}), start: vi.fn() }),
}));
const { OperationsPanel } = await import('./OperationsPanel');

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); state.operations = []; state.offline = false; vi.clearAllMocks(); });

const base: SyncOperation = {
  id: 'o1', kind: 'copy', status: 'running', targetId: 'd_t', targetName: 'Tausch', itemCount: 12, totalItems: 20, doneItems: 5,
  totalBytes: 1000, doneBytes: 250, conflict: null, results: [], error: null, createdAt: '2026-10-18T10:00:00Z', finishedAt: null,
};

it('renders nothing without visible operations', () => {
  const { container } = render(<OperationsPanel />);
  expect(container).toBeEmptyDOMElement();
});

it('shows title, byte progress and cancel for a running operation', () => {
  state.operations = [{ op: base, visible: true, conflictOpen: false }];
  render(<OperationsPanel />);
  expect(screen.getByText('Copying 12 items to “Tausch”')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).toHaveBeenCalledWith('o1');
});

it('a finished operation with failures lists them and can be closed', () => {
  state.operations = [{
    op: { ...base, status: 'done', finishedAt: '2026-10-18T10:01:00Z', results: [
      { sourceId: 'f_a', name: 'a.txt', outcome: 'done' }, { sourceId: 'f_b', name: 'b.txt', outcome: 'failed', error: 'not_found' },
    ] }, visible: true, conflictOpen: false,
  }];
  render(<OperationsPanel />);
  expect(screen.getByText('1 of 12 copied')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Show errors' }));
  expect(screen.getByText('b.txt – no longer exists')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(dismiss).toHaveBeenCalledWith('o1');
});

it('a waiting operation offers "Decide"; a failed one shows its reason; offline is shown', () => {
  state.offline = true;
  state.operations = [
    { op: { ...base, status: 'waiting', conflict: { sourceId: 'f_a', name: 'a', canReplace: true, source: { type: 'file', size: 1, modifiedAt: base.createdAt }, existing: { id: 'f_x', type: 'file', size: 1, modifiedAt: base.createdAt } } }, visible: true, conflictOpen: false },
    { op: { ...base, id: 'o2', status: 'failed', error: 'storage_full', finishedAt: base.createdAt }, visible: true, conflictOpen: false },
  ];
  render(<OperationsPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Decide' }));
  expect(setConflictOpen).toHaveBeenCalledWith('o1', true);
  expect(screen.getByText('The destination is full.')).toBeInTheDocument();
  expect(screen.getByText('Connection lost – the operation continues on the server.')).toBeInTheDocument();
});
