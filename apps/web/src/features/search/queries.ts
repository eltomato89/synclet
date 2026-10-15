import type { SearchHit, SearchResponse } from '@synclet/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export const SEARCH_DEBOUNCE_MS = 200;
/** Server limit for `q` (MAX_QUERY_CHARS). */
export const MAX_QUERY_LENGTH = 200;
const PAGE = 30;

/** `value`, updated only after it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function searchUrl(q: string, folderId: string | null): string {
  const qs = new URLSearchParams({ q, limit: String(PAGE) });
  if (folderId) qs.set('folder', folderId);
  return `/sync/v1/search?${qs.toString()}`;
}

/** Debounced search; disabled for an empty query. `folderId` limits it to that subtree. */
export function useSearch(query: string, folderId: string | null) {
  const q = useDebounced(query.trim().slice(0, MAX_QUERY_LENGTH), SEARCH_DEBOUNCE_MS);
  const result = useQuery({
    queryKey: ['search', q, folderId],
    queryFn: ({ signal }) => api<SearchResponse>(searchUrl(q, folderId), { signal }),
    enabled: q.length > 0,
    // Keep showing the previous hits while the next query runs (no flicker while typing).
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  });
  /** The query the shown data belongs to (lags behind while typing). */
  return { ...result, settledQuery: q, pending: q !== query.trim().slice(0, MAX_QUERY_LENGTH) || result.isFetching };
}

export interface HitGroups { names: SearchHit[]; contents: SearchHit[] }

/** "Names" holds everything whose name matched (also with content), "Contents" the rest. */
export function groupHits(hits: SearchHit[]): HitGroups {
  return {
    names: hits.filter((h) => h.matched !== 'content'),
    contents: hits.filter((h) => h.matched === 'content'),
  };
}

/** Folder chain of a hit for display: `''` is the root. */
export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

// ---- recent searches (per user, localStorage; storage may be unavailable) -----------------------

const RECENT_MAX = 6;
const recentKey = (userId: string) => `synclet.search.recent.${userId}`;

export function readRecentSearches(userId: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(userId)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

/** Puts `q` first (case-insensitive dedupe) and returns the new list. */
export function addRecentSearch(userId: string, q: string): string[] {
  const query = q.trim().slice(0, MAX_QUERY_LENGTH);
  const prev = readRecentSearches(userId);
  if (!query) return prev;
  const next = [query, ...prev.filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(0, RECENT_MAX);
  try { localStorage.setItem(recentKey(userId), JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

export function clearRecentSearches(userId: string): void {
  try { localStorage.removeItem(recentKey(userId)); } catch { /* storage unavailable */ }
}
