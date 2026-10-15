import { createContext, type MouseEvent, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { errorFrom, PublicError } from './api';

/** Receives errors that concern the whole link (404 / 410 / 401 password), see gate.ts. */
export const ShareErrorContext = createContext<(e: unknown) => void>(() => {});

/**
 * Checks that a single-file download would succeed, by asking for its first byte
 * (`Range: bytes=0-0`). Resolves null when it would, the error otherwise. The body is not read.
 */
export async function probeDownload(url: string): Promise<PublicError | null> {
  const ac = new AbortController();
  try {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Range: 'bytes=0-0' }, signal: ac.signal });
    if (res.ok) return null; // 206, or 200 from a server ignoring Range (aborted below)
    // An empty file has no byte 0: 416 means the file is there and downloadable.
    if (res.status === 416) return null;
    const body = await res.json().catch(() => null);
    return errorFrom(res.status, body, res.headers.get('Retry-After'), res.statusText);
  } catch (e) {
    return new PublicError(0, 'network', e instanceof Error ? e.message : 'network error');
  } finally {
    ac.abort();
  }
}

/** Starts a download of `url` (attachment disposition: the page stays). */
function startDownload(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

export function downloadErrorKey(e: PublicError): string {
  if (e.status === 429 || e.code === 'rate_limited' || e.code === 'busy') return 'publicShare.downloadErrors.rateLimited';
  if (e.status === 403) return 'publicShare.downloadErrors.forbidden';
  if (e.status === 404) return 'publicShare.downloadErrors.notFound';
  if (e.code === 'network') return 'publicShare.downloadErrors.network';
  return 'publicShare.downloadErrors.unknown';
}

/**
 * Click handlers for single-file download links (`<a href download>`): probes first and reports
 * 403 / 429 / 503 / network errors in the page instead of letting the browser save the JSON
 * error body. Link-level errors (gone, expired, locked) go to the page's gate.
 * ZIP links are not probed (that would start building the archive); they show a hint instead.
 * Usage: `onClick={probed(size)}`; empty files skip the probe (nothing to range over).
 */
export function useProbedDownload() {
  const { t } = useTranslation();
  const onShareError = useContext(ShareErrorContext);
  return useCallback((size: number) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (size === 0) return; // plain download
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // keep "open in new tab" etc.
    e.preventDefault();
    const url = e.currentTarget.href;
    void probeDownload(url).then((err) => {
      if (!err) { startDownload(url); return; }
      // 404 here is this file (deleted or moved out); a gone link shows up on the next listing.
      if (err.status === 410 || err.code === 'share_password_required') { onShareError(err); return; }
      toast.error(t(downloadErrorKey(err)));
    });
  }, [onShareError, t]);
}
