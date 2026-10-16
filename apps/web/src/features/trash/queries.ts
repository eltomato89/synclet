import type { RestoreResult, TrashEntryWire } from '@synclet/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const TRASH_KEY = ['trash'] as const;

export function useTrash() {
  return useQuery({ queryKey: TRASH_KEY, queryFn: () => api<TrashEntryWire[]>('/trash') });
}

/**
 * Everything a trash operation can change: the trash itself, used storage, and every folder
 * listing (a restore lands wherever the original parent is now, or at the root). Share links
 * follow their item, so they reappear or vanish with it; recent files and search results too.
 */
export function invalidateAfterTrashChange(qc: QueryClient) {
  for (const key of [TRASH_KEY, ['account'], ['folder'], ['subfolders'], ['shares'], ['recent'], ['search']]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export function useTrashMutations() {
  const qc = useQueryClient();
  const drop = (ids: string[] | 'all') => qc.setQueryData<TrashEntryWire[]>(
    TRASH_KEY,
    // Emptying removes only the personal space's entries; other spaces' entries stay listed.
    (list) => list?.filter((e) => (ids === 'all' ? (e.spaceId ?? 'personal') !== 'personal' : !ids.includes(e.id))),
  );
  const settled = () => invalidateAfterTrashChange(qc);
  return {
    restore: useMutation({
      mutationFn: (entry: Pick<TrashEntryWire, 'id'>) => api<RestoreResult>(`/trash/${entry.id}/restore`, { method: 'POST' }),
      onSuccess: (_r, entry) => drop([entry.id]),
      onSettled: settled,
    }),
    deleteForever: useMutation({
      mutationFn: (entry: Pick<TrashEntryWire, 'id'>) => api<void>(`/trash/${entry.id}`, { method: 'DELETE' }),
      onSuccess: (_r, entry) => drop([entry.id]),
      onSettled: settled,
    }),
    empty: useMutation({
      mutationFn: () => api<{ removed: number }>('/trash', { method: 'DELETE' }),
      onSuccess: () => drop('all'),
      onSettled: settled,
    }),
  };
}

const DAY = 86_400_000;

export type ExpiresIn = { kind: 'never' } | { kind: 'today' } | { kind: 'days'; days: number };

/**
 * When a trash entry is deleted for good. Whole days are rounded up, so an entry deleted a
 * moment ago with 30 days retention reads "in 30 days"; less than a day left reads "today".
 */
export function expiresIn(expiresAt: string | null, now: number = Date.now()): ExpiresIn {
  if (!expiresAt) return { kind: 'never' };
  const left = new Date(expiresAt).getTime() - now;
  if (!(left >= DAY)) return { kind: 'today' };
  return { kind: 'days', days: Math.ceil(left / DAY) };
}

/** Retention in whole days, derived from an entry (the server does not expose the setting). */
export function retentionDays(entries: TrashEntryWire[]): number | null {
  const e = entries.find((x) => x.expiresAt);
  if (!e?.expiresAt) return null;
  return Math.round((new Date(e.expiresAt).getTime() - new Date(e.deletedAt).getTime()) / DAY);
}

/** Folder segments of a path relative to the user folder, without the item's own name. */
export function parentSegments(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1);
}
