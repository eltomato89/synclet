import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { PublicError } from './api';
import { probeDownload, ShareErrorContext, useProbedDownload } from './download';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const URL_ = '/api/public/shares/tok/items/f_1/content?download=1';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); toastError.mockReset(); });

describe('probeDownload', () => {
  it('asks for the first byte only and resolves null when the download would work', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('a', { status: 206 }));
    await expect(probeDownload(URL_)).resolves.toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_);
    expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-0');
    expect(init?.credentials).toBe('same-origin');
  });

  it('treats 416 (empty file, no byte 0) as downloadable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(416, { code: 'range_not_satisfiable' }));
    await expect(probeDownload(URL_)).resolves.toBeNull();
  });

  it('returns the error for 403, 429 and 503', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(403, { code: 'forbidden' }))
      .mockResolvedValueOnce(json(429, { code: 'rate_limited' }, { 'Retry-After': '1' }))
      .mockResolvedValueOnce(json(503, { code: 'rate_limited' }));
    expect(await probeDownload(URL_)).toMatchObject({ status: 403, code: 'forbidden' });
    expect(await probeDownload(URL_)).toMatchObject({ status: 429, retryAfter: 1 });
    expect(await probeDownload(URL_)).toMatchObject({ status: 503, code: 'busy' });
  });
});

function Link({ onShareError = () => {}, size = 5 }: { onShareError?: (e: unknown) => void; size?: number }) {
  return <ShareErrorContext.Provider value={onShareError}><Inner size={size} /></ShareErrorContext.Provider>;
}
function Inner({ size }: { size: number }) {
  const probed = useProbedDownload();
  return <a href={URL_} download onClick={probed(size)}>dl</a>;
}

describe('useProbedDownload', () => {
  it('starts the download when the probe succeeds', async () => {
    void i18n.changeLanguage('en');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('a', { status: 206 }));
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.getAttribute('href')!); });
    render(<Link />);
    await act(async () => { fireEvent.click(screen.getByText('dl')); });
    expect(clicks).toEqual([expect.stringContaining('/items/f_1/content?download=1')]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does not probe empty files: the link downloads directly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<Link size={0} />);
    const link = screen.getByText('dl');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => { link.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a message instead of downloading on 503, and hands 410 to the page', async () => {
    void i18n.changeLanguage('en');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(503, { code: 'rate_limited' }))
      .mockResolvedValueOnce(json(410, { code: 'share_expired' }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onShareError = vi.fn();
    render(<Link onShareError={onShareError} />);
    await act(async () => { fireEvent.click(screen.getByText('dl')); });
    expect(toastError).toHaveBeenCalledWith('Too many downloads right now. Try again in a moment.');
    await act(async () => { fireEvent.click(screen.getByText('dl')); });
    expect(onShareError).toHaveBeenCalledWith(expect.any(PublicError));
    expect(click).not.toHaveBeenCalled();
  });
});
