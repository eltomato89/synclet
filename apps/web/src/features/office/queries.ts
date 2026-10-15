import type { OfficeEditorConfig, OfficeNewFormat, ServerCapabilities, SyncItem } from '@synclet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';

/** What the web assumes when the server cannot tell (older server, offline): optional features off. */
export const FALLBACK_CAPABILITIES: ServerCapabilities = { versions: false, office: { enabled: false, url: null } };

export async function fetchCapabilities(): Promise<ServerCapabilities> {
  try {
    return await api<ServerCapabilities>('/sync/v1/capabilities');
  } catch (err) {
    // 404: a server without the route, so none of the optional features. Anything else (network,
    // 5xx) is unknown: the query errors, the hook reports the fallback and a later refetch retries.
    if (err instanceof ApiError && err.status === 404) return FALLBACK_CAPABILITIES;
    throw err;
  }
}

/** Optional server features (versions, office). Cached for the session; never undefined. */
export function useCapabilities(): ServerCapabilities {
  const q = useQuery({
    queryKey: ['capabilities'],
    queryFn: fetchCapabilities,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return q.data ?? FALLBACK_CAPABILITIES;
}

export function fetchEditorConfig(itemId: string, lang: string): Promise<OfficeEditorConfig> {
  const l = lang.startsWith('de') ? 'de' : 'en';
  return api<OfficeEditorConfig>(`/sync/v1/items/${encodeURIComponent(itemId)}/office?lang=${l}`);
}

/** New empty document from a template in `parentId`; the server picks a free name if taken. */
export function useCreateOfficeFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { parentId: string; name: string; format: OfficeNewFormat }) =>
      api<SyncItem>('/sync/v1/items/new-office', { method: 'POST', json: v }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['folder', v.parentId] });
      void qc.invalidateQueries({ queryKey: ['recent'] });
      void qc.invalidateQueries({ queryKey: ['account'] });
    },
  });
}
