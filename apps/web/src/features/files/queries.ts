import type { SyncChildrenPage, SyncItem } from '@synclet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';

export const ROOT_ID = 'root';

/** Retry network/server failures, never client errors such as 404 for a missing folder. */
const retry = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 3;

/** Route for a folder: `/files` is the root, every other folder lives at `/files/d_<uuid>`. */
export function folderPath(folderId: string): string {
  return folderId === ROOT_ID ? '/files' : `/files/${folderId}`;
}

export async function fetchAllChildren(folderId: string): Promise<SyncItem[]> {
  const out: SyncItem[] = [];
  let token: string | null = null;
  do {
    const qs: string = `limit=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const page: SyncChildrenPage = await api<SyncChildrenPage>(`/sync/v1/items/${folderId}/children?${qs}`);
    out.push(...page.items);
    token = page.nextPageToken;
  } while (token);
  return out;
}

export type SortKey = 'name' | 'modifiedAt' | 'size';
export type SortDir = 'asc' | 'desc';

export function sortItems(items: SyncItem[], key: SortKey, dir: SortDir, locale: string): SyncItem[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const f = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (key === 'size') return f * (a.size - b.size) || collator.compare(a.name, b.name);
    if (key === 'modifiedAt') return f * a.modifiedAt.localeCompare(b.modifiedAt) || collator.compare(a.name, b.name);
    return f * collator.compare(a.name, b.name);
  });
}

export function useFolder(folderId: string) {
  return useQuery({
    queryKey: ['folder', folderId],
    queryFn: async () => {
      const [folder, items] = await Promise.all([api<SyncItem>(`/sync/v1/items/${folderId}`), fetchAllChildren(folderId)]);
      return { folder, items };
    },
    refetchInterval: 15_000,
    retry,
  });
}

/** Sub-folders of a folder, for the move dialog's tree (no polling). */
export function useSubfolders(folderId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['subfolders', folderId],
    queryFn: async () => (await fetchAllChildren(folderId)).filter((i) => i.type === 'folder'),
    enabled,
    staleTime: 0,
  });
}

export function useAncestors(folderId: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['ancestors', folderId],
    queryFn: async () => {
      const chain: SyncItem[] = [];
      let id: string | null = folderId;
      while (id) {
        const cur: string = id;
        const item: SyncItem = await qc.fetchQuery({ queryKey: ['item', cur], queryFn: () => api<SyncItem>(`/sync/v1/items/${cur}`), staleTime: 30_000 });
        chain.unshift(item);
        id = item.parentId;
      }
      return chain;
    },
    retry,
  });
}

export async function downloadItem(item: SyncItem) {
  const { url } = await api<{ url: string }>(`/sync/v1/items/${item.id}/download-token`, { method: 'POST' });
  window.location.assign(url);
}

export function useFileMutations() {
  const qc = useQueryClient();
  const done = (...folderIds: (string | null)[]) => {
    for (const f of folderIds) {
      if (!f) continue;
      void qc.invalidateQueries({ queryKey: ['folder', f] });
      void qc.invalidateQueries({ queryKey: ['subfolders', f] });
    }
    void qc.invalidateQueries({ queryKey: ['account'] });
    void qc.invalidateQueries({ queryKey: ['ancestors'] });
  };
  /** A renamed or moved folder changes the breadcrumb of everything below it. */
  const forget = (item: SyncItem) => { if (item.type === 'folder') qc.removeQueries({ queryKey: ['item', item.id] }); };
  return {
    createFolder: useMutation({
      mutationFn: (v: { parentId: string; name: string }) => api<SyncItem>('/sync/v1/items', { method: 'POST', json: { parentId: v.parentId, type: 'folder', name: v.name } }),
      onSuccess: (_r, v) => done(v.parentId),
    }),
    rename: useMutation({
      mutationFn: (v: { item: SyncItem; name: string }) => api<SyncItem>(`/sync/v1/items/${v.item.id}`, { method: 'PATCH', json: { name: v.name } }),
      onSuccess: (_r, v) => { forget(v.item); done(v.item.parentId); },
    }),
    move: useMutation({
      mutationFn: (v: { item: SyncItem; targetId: string }) => api<SyncItem>(`/sync/v1/items/${v.item.id}`, { method: 'PATCH', json: { parentId: v.targetId } }),
      onSuccess: (_r, v) => { forget(v.item); done(v.item.parentId, v.targetId); },
    }),
    remove: useMutation({
      mutationFn: (item: SyncItem) => api<void>(`/sync/v1/items/${item.id}`, { method: 'DELETE' }),
      onSuccess: (_r, item) => { forget(item); done(item.parentId); },
    }),
    download: downloadItem,
  };
}
