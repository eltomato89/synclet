import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { UploadPanel } from './UploadPanel';
import { type UploadTransport, UploadQueue } from './uploads';

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) };
  onload: null | (() => void) = null; onerror: null | (() => void) = null;
  status = 0; responseText = '';
  open() {} setRequestHeader() {}
  send() { FakeXHR.instances.push(this); }
  abort() {}
}
const RAW: UploadTransport = { Upload: class {} as unknown as UploadTransport['Upload'], supported: false };

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

it('shows a folder upload as one row with its file count and folder errors', () => {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
  const q = new UploadQueue(() => 'tok', () => {}, undefined, RAW);
  const g = q.addGroup('Urlaub');
  render(<UploadPanel queue={q} />);
  expect(screen.getByText('Folder “Urlaub”: 0 of 0 files')).toBeInTheDocument();
  expect(screen.getAllByText('Creating folders …').length).toBeGreaterThan(0);

  act(() => {
    q.updateGroup(g, { name: 'Urlaub (2)' });
    q.enqueue([new File(['x'], 'a.jpg'), new File(['y'], 'b.jpg')], 'd_1', g);
    q.updateGroup(g, { state: 'ready', errors: [{ path: 'Urlaub/Bilder', code: 'invalid_name', files: 3 }] });
  });
  act(() => {
    const x = FakeXHR.instances[0];
    x.status = 201; x.responseText = JSON.stringify({ id: 'f_1', name: 'a.jpg' }); x.onload?.();
  });
  expect(screen.getByText('Folder “Urlaub (2)”: 1 of 2 files')).toBeInTheDocument();
  expect(screen.getByText(/1 folder could not be created/)).toBeInTheDocument();
  expect(screen.getByText(/“Urlaub\/Bilder”:/)).toBeInTheDocument();
  // Grouped files are not listed one by one.
  expect(screen.queryByText('b.jpg')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel folder upload' }));
  expect(q.groupSnapshot()).toEqual([]);
  expect(q.snapshot()).toEqual([]);
});
