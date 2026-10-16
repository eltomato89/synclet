import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { FolderConflictDialog } from './FolderConflictDialog';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

const folderQ = { name: 'Urlaub', existingType: 'folder' as const, keepName: 'Urlaub (2)', remaining: 2 };

it('offers merge, keep as "(2)" and cancel for an existing folder, plus "apply to all"', () => {
  const onAnswer = vi.fn();
  render(<FolderConflictDialog question={folderQ} onAnswer={onAnswer} />);
  expect(screen.getByRole('heading', { name: '“Urlaub” already exists' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Apply to all' }));
  fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
  expect(onAnswer).toHaveBeenCalledWith({ choice: 'merge', applyAll: true });
});

it('keeps both without "apply to all"', () => {
  const onAnswer = vi.fn();
  render(<FolderConflictDialog question={folderQ} onAnswer={onAnswer} />);
  fireEvent.click(screen.getByRole('button', { name: 'Keep as “Urlaub (2)”' }));
  expect(onAnswer).toHaveBeenCalledWith({ choice: 'rename', applyAll: false });
});

it('cannot merge into a file and hides "apply to all" for the last conflict', () => {
  const onAnswer = vi.fn();
  render(<FolderConflictDialog question={{ ...folderQ, existingType: 'file', remaining: 0 }} onAnswer={onAnswer} />);
  expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onAnswer).toHaveBeenCalledWith({ choice: 'cancel', applyAll: false });
});

it('Escape cancels', () => {
  const onAnswer = vi.fn();
  render(<FolderConflictDialog question={folderQ} onAnswer={onAnswer} />);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onAnswer).toHaveBeenCalledWith({ choice: 'cancel', applyAll: false });
});

it('renders nothing without a question', () => {
  render(<FolderConflictDialog question={null} onAnswer={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});
