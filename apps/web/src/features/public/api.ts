import type { PublicShareEntry, PublicShareInfo } from '@synclet/shared';

/**
 * Client of the anonymous share API (`/api/public/shares/:token`).
 *
 * Deliberately independent of `lib/api.ts`: no bearer token, no session refresh, no redirect to
 * the login page. The only credential is the httpOnly unlock cookie the server scopes to
 * `/api/public/shares/<token>`, which the browser attaches on its own (same origin).
 */

/** Error of a public request. `code` is the server's error code, or `network` / `busy` / `unknown`. */
export class PublicError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from the Retry-After header (429 / 503), if any. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/**
 * `PublicShareInfo` as the page reads it. `id` (the shared item's sync id) is not part of the
 * server response yet; while it is missing, the shared file of a file share is addressed with
 * an empty item id (`items//content`), which the server resolves to the shared item itself.
 */
export type ShareInfo = PublicShareInfo & { id?: string };

const enc = encodeURIComponent;

/** Every URL of one share. Item ids are sync ids (`f_…` / `d_…`); `''` means the shared item. */
export function shareUrls(token: string) {
  const base = `/api/public/shares/${enc(token)}`;
  const item = (id: string) => `${base}/items/${enc(id)}`;
  const folderQuery = (folder?: string | null) => (folder ? `?folder=${enc(folder)}` : '');
  return {
    info: base,
    unlock: `${base}/unlock`,
    items: (folder?: string | null) => `${base}/items${folderQuery(folder)}`,
    content: (id: string, opts: { download?: boolean } = {}) => `${item(id)}/content${opts.download ? '?download=1' : ''}`,
    thumbnail: (id: string, size: 256 | 1024) => `${item(id)}/thumbnail?size=${size}`,
    zip: (folder?: string | null) => `${base}/zip${folderQuery(folder)}`,
    upload: (name: string, folder?: string | null) => {
      const q = new URLSearchParams({ name });
      if (folder) q.set('folder', folder);
      return `${base}/upload?${q.toString()}`;
    },
  };
}

function retryAfterOf(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Builds a PublicError from a failed response (body `{ code, message }` when the server sent one). */
export function errorFrom(status: number, body: unknown, retryAfter: string | null, fallback = ''): PublicError {
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; message?: unknown };
  let code = typeof b.code === 'string' ? b.code : status >= 500 ? 'server_error' : 'unknown';
  if (status === 503 && code === 'rate_limited') code = 'busy'; // server at capacity, not this client
  const message = typeof b.message === 'string' ? b.message : fallback;
  return new PublicError(status, code, message, retryAfterOf(retryAfter));
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new PublicError(0, 'network', e instanceof Error ? e.message : 'network error');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw errorFrom(res.status, body, res.headers.get('Retry-After'), res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function fetchShareInfo(token: string, signal?: AbortSignal): Promise<ShareInfo> {
  return request<ShareInfo>(shareUrls(token).info, { signal });
}

/** Unlocks a password-protected share: on success the server sets the unlock cookie. */
export function unlockShare(token: string, password: string): Promise<void> {
  return request<void>(shareUrls(token).unlock, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

export function listShareItems(token: string, folder?: string | null, signal?: AbortSignal): Promise<PublicShareEntry[]> {
  return request<PublicShareEntry[]>(shareUrls(token).items(folder), { signal });
}

/**
 * Uploads one file into the share (or a folder inside it) with a plain XHR POST, for progress
 * events. Anonymous uploads are single requests (no tus); the server renames on conflict and
 * answers with the created entry, whose `name` may differ from `file.name`.
 */
export function uploadToShare(
  token: string,
  folder: string | null,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<PublicShareEntry> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', shareUrls(token).upload(file.name, folder));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* empty or not JSON */ }
      if (xhr.status === 201 || xhr.status === 200) {
        onProgress(1);
        resolve(body as PublicShareEntry);
      } else {
        reject(errorFrom(xhr.status, body, xhr.getResponseHeader('Retry-After'), xhr.statusText));
      }
    };
    xhr.onerror = () => reject(new PublicError(0, 'network', 'network error'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
