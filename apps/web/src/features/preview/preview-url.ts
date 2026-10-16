import type { SyncItem } from '@synclet/shared';
import { api } from '@/lib/api';

/**
 * Preview tokens
 * ==============
 * `<img>`, `<video>` and `<iframe>` cannot send an Authorization header, so inline URLs carry an
 * item-bound `?dt=` token from `POST items/:id/download-token?purpose=preview` (valid 6 h on the
 * server). Tokens are cached in memory per item id + etag for 5 h, so a URL handed to the DOM
 * always has at least an hour left, and a new file version gets a new URL (thumbnails are served
 * `immutable`, the browser cache must not hand out the old picture for the new version).
 */
export const PREVIEW_TOKEN_CACHE_MS = 5 * 3600 * 1000;
/** Token requests in flight at once: a folder full of photos must not fire hundreds of POSTs. */
const MAX_CONCURRENT = 6;

export interface PreviewToken { token: string; contentUrl: string }
interface Entry { key: string; at: number; promise: Promise<PreviewToken> }

const cache = new Map<string, Entry>();
let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  // A finishing request hands its slot straight to the next waiter.
  if (active < MAX_CONCURRENT) active++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}

const cacheKey = (item: Pick<SyncItem, 'id' | 'etag'>) => `${item.id}\n${item.etag}`;

/** A preview token for the item's current version; cached and shared by concurrent callers. */
export function previewToken(item: Pick<SyncItem, 'id' | 'etag'>, now = Date.now()): Promise<PreviewToken> {
  const key = cacheKey(item);
  const hit = cache.get(item.id);
  if (hit && hit.key === key && now - hit.at < PREVIEW_TOKEN_CACHE_MS) return hit.promise;
  const promise = limited(() => api<{ url: string; token: string }>(
    `/sync/v1/items/${encodeURIComponent(item.id)}/download-token?purpose=preview`, { method: 'POST' },
  )).then(({ url, token }) => ({ token, contentUrl: url }));
  const entry: Entry = { key, at: now, promise };
  cache.set(item.id, entry);
  // A failed request is not cached: the next caller tries again.
  promise.catch(() => { if (cache.get(item.id) === entry) cache.delete(item.id); });
  return promise;
}

/** The cached token if it is already resolved and fresh (lets the UI skip a loading state). */
export function peekPreviewToken(item: Pick<SyncItem, 'id' | 'etag'>, now = Date.now()): Promise<PreviewToken> | null {
  const hit = cache.get(item.id);
  return hit && hit.key === cacheKey(item) && now - hit.at < PREVIEW_TOKEN_CACHE_MS ? hit.promise : null;
}

/**
 * Thumbnail URL for a token. `v` busts the browser cache when the file changes; a folder's
 * mosaic (`composite=1`) changes with its children, which its `preview.thumbnailKey` tracks.
 */
export function thumbnailUrlFor(item: Pick<SyncItem, 'id' | 'etag'> & Partial<Pick<SyncItem, 'type' | 'preview'>>, token: string, size: 256 | 1024): string {
  const folder = item.type === 'folder';
  const v = folder ? item.preview?.thumbnailKey ?? item.etag : item.etag;
  return `/api/sync/v1/items/${encodeURIComponent(item.id)}/thumbnail?size=${size}${folder ? '&composite=1' : ''}&v=${encodeURIComponent(v)}&dt=${encodeURIComponent(token)}`;
}

/** For tests. */
export function clearPreviewTokens() { cache.clear(); }
