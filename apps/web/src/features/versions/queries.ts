import type { SyncItem, VersionWire } from '@synclet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

const base = (itemId: string) => `/sync/v1/items/${encodeURIComponent(itemId)}/versions`;

/** Version content route (the `/api` prefix included) for use in `<img>`, `fetch` and downloads. */
export function versionContentUrl(itemId: string, versionId: string, token: string): string {
  return `/api${base(itemId)}/${encodeURIComponent(versionId)}/content?dt=${encodeURIComponent(token)}`;
}

/** Superseded versions of a file, newest first. Only enabled while the panel is open. */
export function useVersions(itemId: string, enabled = true) {
  return useQuery({
    queryKey: ['versions', itemId],
    queryFn: () => api<VersionWire[]>(base(itemId)),
    enabled,
    retry: 1,
  });
}

/** Starts a browser download of one version (the route is always an attachment). */
export async function downloadVersion(itemId: string, versionId: string): Promise<void> {
  const { token } = await api<{ token: string }>(`/sync/v1/items/${encodeURIComponent(itemId)}/download-token`, { method: 'POST' });
  window.location.assign(versionContentUrl(itemId, versionId, token));
}

/** Makes a version current again; the replaced current file is kept as a new version by the server. */
export function useRestoreVersion(item: Pick<SyncItem, 'id' | 'parentId'>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => api<SyncItem>(`${base(item.id)}/${encodeURIComponent(versionId)}/restore`, { method: 'POST' }),
    onSettled: () => {
      // Also on failure (412: the file changed meanwhile), so the list shows what is really there.
      void qc.invalidateQueries({ queryKey: ['versions', item.id] });
      void qc.invalidateQueries({ queryKey: ['item', item.id] });
      if (item.parentId) {
        void qc.invalidateQueries({ queryKey: ['folder', item.parentId] });
      }
      void qc.invalidateQueries({ queryKey: ['recent'] });
      void qc.invalidateQueries({ queryKey: ['search'] });
      void qc.invalidateQueries({ queryKey: ['account'] });
    },
  });
}
