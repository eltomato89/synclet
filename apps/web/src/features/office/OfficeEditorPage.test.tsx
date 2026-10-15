import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { ApiError } from '@/lib/api';
import i18n from '@/lib/i18n';
import { apiScriptUrl, resetDocsApiForTests } from './office';
import { OfficeEditorPage, officeErrorKind } from './OfficeEditorPage';

const SERVER = 'https://office.example.com';
const SRC = apiScriptUrl(SERVER);
const config = {
  documentServerUrl: SERVER,
  editable: true,
  config: { document: { title: 'Plan.docx', key: 'k' }, editorConfig: { mode: 'edit' }, token: 'jwt' },
};

const created: { id: string; config: Record<string, unknown> }[] = [];
const destroyed: string[] = [];
class FakeEditor {
  constructor(readonly id: string, readonly config: Record<string, unknown>) {
    created.push({ id, config });
    const iframe = document.createElement('iframe');
    document.getElementById(id)!.replaceWith(iframe);
  }
  destroyEditor() { destroyed.push(this.id); }
}

/** Lets the injected api.js script "load" (or fail). */
function settleScript(ok: boolean) {
  const el = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
  if (!el) throw new Error('no api.js script');
  if (ok) window.DocsAPI = { DocEditor: FakeEditor as never };
  el.dispatchEvent(new Event(ok ? 'load' : 'error'));
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  created.length = 0;
  destroyed.length = 0;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});
afterEach(() => { cleanup(); resetDocsApiForTests(); vi.restoreAllMocks(); vi.useRealTimers(); document.title = ''; });

function renderPage(id = 'f_1') {
  return render(
    <MemoryRouter initialEntries={[`/office/${id}`]}>
      <Routes><Route path="/office/:itemId" element={<OfficeEditorPage />} /></Routes>
    </MemoryRouter>,
  );
}

it('loads the editor with the server config, full size, and cleans up on unmount', async () => {
  const api = vi.spyOn(apiMod, 'api').mockResolvedValue(config);
  const view = renderPage();
  expect(screen.getByText('Opening in Office …')).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector(`script[src="${SRC}"]`)).not.toBeNull());
  expect(api).toHaveBeenCalledWith('/sync/v1/items/f_1/office?lang=en');
  expect(document.title).toBe('Plan.docx – Synclet');
  await act(async () => settleScript(true));
  await waitFor(() => expect(created).toHaveLength(1));
  const c = created[0].config;
  expect(c).toMatchObject({ ...config.config, width: '100%', height: '100%', type: 'desktop' });
  // Our overlay stays until the editor reports it is ready.
  expect(screen.getByRole('status')).toBeInTheDocument();
  await act(async () => (c.events as { onAppReady(): void }).onAppReady());
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount();
  expect(destroyed).toEqual([created[0].id]);
  expect(document.title).toBe('');
});

it('uses the mobile editor on narrow screens', async () => {
  window.matchMedia = vi.fn((q: string) => ({ matches: q === '(max-width: 700px)' })) as never;
  vi.spyOn(apiMod, 'api').mockResolvedValue(config);
  renderPage();
  await waitFor(() => expect(document.querySelector(`script[src="${SRC}"]`)).not.toBeNull());
  await act(async () => settleScript(true));
  await waitFor(() => expect(created[0]?.config.type).toBe('mobile'));
});

it('explains a server without office and offers retry and close', async () => {
  vi.spyOn(apiMod, 'api').mockRejectedValue(new ApiError(503, 'office_disabled', 'office editing is not configured'));
  renderPage();
  expect(await screen.findByRole('heading', { name: "Office isn't set up" })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close tab' })).toBeInTheDocument();
  expect(document.querySelector('script[data-office-api]')).toBeNull();
});

it('shows "Office ist nicht eingerichtet" in German', async () => {
  await i18n.changeLanguage('de');
  vi.spyOn(apiMod, 'api').mockRejectedValue(new ApiError(503, 'office_disabled', 'x'));
  renderPage();
  expect(await screen.findByRole('heading', { name: 'Office ist nicht eingerichtet' })).toBeInTheDocument();
});

it('retries after api.js failed to load', async () => {
  const api = vi.spyOn(apiMod, 'api').mockResolvedValue(config);
  renderPage();
  await waitFor(() => expect(document.querySelector(`script[src="${SRC}"]`)).not.toBeNull());
  await act(async () => settleScript(false));
  expect(await screen.findByRole('heading', { name: "The Office server isn't responding" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Opening in Office …')).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector(`script[src="${SRC}"]`)).not.toBeNull());
  await act(async () => settleScript(true));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(api).toHaveBeenCalledTimes(2);
});

it('gives up waiting when the editor never becomes ready', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(apiMod, 'api').mockResolvedValue(config);
  renderPage();
  await waitFor(() => expect(document.querySelector(`script[src="${SRC}"]`)).not.toBeNull());
  await act(async () => settleScript(true));
  await waitFor(() => expect(created).toHaveLength(1));
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByRole('heading', { name: "The Office server isn't responding" })).toBeInTheDocument();
});

it('offers no retry for unsupported or missing files', async () => {
  vi.spyOn(apiMod, 'api').mockRejectedValue(new ApiError(415, 'invalid_request', 'type'));
  renderPage();
  expect(await screen.findByRole('heading', { name: "This file type can't be opened in Office" })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('maps errors to panels', () => {
  expect(officeErrorKind(new ApiError(503, 'office_disabled', ''))).toBe('disabled');
  expect(officeErrorKind(new ApiError(503, 'server_error', 'Service Unavailable'))).toBe('serverUnreachable');
  expect(officeErrorKind(new ApiError(415, 'invalid_request', ''))).toBe('unsupported');
  expect(officeErrorKind(new ApiError(404, 'not_found', ''))).toBe('notFound');
  expect(officeErrorKind(new ApiError(400, 'invalid_request', ''))).toBe('notFound');
  expect(officeErrorKind(new ApiError(0, 'network', ''))).toBe('serverUnreachable');
  expect(officeErrorKind(new Error('could not load'))).toBe('editorUnreachable');
});
