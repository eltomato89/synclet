import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { routes } from '@/app/router';

const TOKEN = 'lR9zzMewDYRVy0tlYwQ9158nOL8ut4E2BT4gU41Nyrg';
const BASE = `/api/public/shares/${TOKEN}`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const folderInfo = {
  name: 'Urlaub 2026', type: 'folder', size: 4096, mime: null, ownerDisplayName: 'Jens Köhler',
  allowDownload: true, allowUpload: true, expiresAt: null,
};
const entries = [
  { id: 'd_1', name: 'Fotos', type: 'folder', size: 0, mime: null, modifiedAt: '2026-10-01T10:00:00Z', hasThumbnail: false },
  { id: 'f_1', name: 'Strand.png', type: 'file', size: 2048, mime: 'image/png', modifiedAt: '2026-10-01T10:00:00Z', hasThumbnail: true },
];

/** Routes fetch calls by URL; records every URL requested. */
function mockServer(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return handler(url, init) ?? json(500, { code: 'unexpected', message: url });
  });
  return urls;
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<Providers><RouterProvider router={router} /></Providers>);
  return router;
}

const noSessionCalls = (urls: string[]) => {
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) {
    expect(u).not.toMatch(/^\/api\/(auth|setup)/);
    expect(u.startsWith(`${BASE}`)).toBe(true);
  }
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.head.querySelectorAll('meta[name="robots"], meta[name="referrer"]').forEach((m) => m.remove());
});

describe('PublicSharePage', () => {
  it('unlocks a password share and lists the folder without any auth request', async () => {
    let unlocked = false;
    const urls = mockServer((url, init) => {
      if (url === `${BASE}/unlock`) {
        const { password } = JSON.parse(String(init?.body)) as { password: string };
        if (password !== 'geheim123') return json(401, { code: 'unauthorized' });
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      if (!unlocked) return json(401, { code: 'share_password_required' });
      if (url === BASE) return json(200, folderInfo);
      if (url === `${BASE}/items`) return json(200, entries);
      return undefined;
    });
    renderAt(`/s/${TOKEN}`);

    const field = await screen.findByLabelText('Password');
    expect(screen.getByRole('heading', { name: 'This link is password protected' })).toBeInTheDocument();
    fireEvent.change(field, { target: { value: 'wrong' } });
    await act(async () => { fireEvent.submit(field.closest('form')!); });
    expect(await screen.findByText("That password isn't right.")).toBeInTheDocument();

    fireEvent.change(field, { target: { value: 'geheim123' } });
    await act(async () => { fireEvent.submit(field.closest('form')!); });

    expect(await screen.findByRole('heading', { name: 'Urlaub 2026' })).toBeInTheDocument();
    expect(screen.getByText('Jens Köhler')).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Contents' });
    expect(within(list).getByText('Fotos')).toBeInTheDocument();
    expect(within(list).getByText('Strand.png')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Download all as ZIP/ })).toHaveAttribute('href', `${BASE}/zip`);
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeInTheDocument();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

    noSessionCalls(urls);
  });

  it('shows the not-found state for unknown or revoked links', async () => {
    const urls = mockServer(() => json(404, { code: 'not_found' }));
    renderAt(`/s/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: "This link doesn't work" })).toBeInTheDocument();
    noSessionCalls(urls);
  });

  it('shows the expired state on 410', async () => {
    mockServer(() => json(410, { code: 'share_expired' }));
    renderAt(`/s/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'This link has expired' })).toBeInTheDocument();
  });

  it('shows a file share without download button when downloads are off, and never renders SVG content inline', async () => {
    const urls = mockServer((url) => (url === BASE
      ? json(200, { ...folderInfo, name: 'logo.svg', type: 'file', mime: 'image/svg+xml', allowDownload: false, allowUpload: false })
      : undefined));
    renderAt(`/s/${TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'logo.svg' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.getByText('View only')).toBeInTheDocument();
    const img = screen.getByRole('img', { name: 'Preview of logo.svg' });
    expect(img).toHaveAttribute('src', `${BASE}/items//thumbnail?size=1024`);
    await act(async () => { fireEvent.error(img); });
    // No thumbnail: fall back to the no-preview panel, never to the SVG itself.
    expect(screen.queryByRole('img', { name: 'Preview of logo.svg' })).toBeNull();
    expect(document.querySelector(`img[src*="/content"]`)).toBeNull();
    expect(screen.getByText(/the owner has turned off downloads/)).toBeInTheDocument();
    noSessionCalls(urls);
  });
});
