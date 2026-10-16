import type { SyncAccount, SyncItem, SyncSpace } from '@synclet/shared';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch } from 'react-router';
import { api } from '@/lib/api';

/** API id of the personal space; its root folder is `root`. */
export const PERSONAL = 'personal';
const ROOT_PREFIX = 'r_';

/** Root folder id of a space: `root` for the personal space, `r_<uuid>` for the others. */
export function spaceRootId(spaceId: string): string {
  return spaceId === PERSONAL ? 'root' : `${ROOT_PREFIX}${spaceId}`;
}

/** The space whose root `folderId` is, or null when it is no space root. */
export function spaceIdOfRoot(folderId: string): string | null {
  if (folderId === 'root') return PERSONAL;
  return folderId.startsWith(ROOT_PREFIX) ? folderId.slice(ROOT_PREFIX.length) : null;
}

/** An item's space; items of older servers carry none and are personal. */
export const spaceOfItem = (item: Pick<SyncItem, 'spaceId'>): string => item.spaceId ?? PERSONAL;

/** The account's spaces; an older server lists none, then there is just the personal one. */
function spacesOf(account: Partial<SyncAccount> | undefined): SyncSpace[] {
  if (!account) return [];
  if (account.spaces?.length) return account.spaces;
  return [{ id: PERSONAL, kind: 'personal', name: '', rootId: 'root', canWrite: account.canWrite ?? true }];
}

/**
 * The spaces the user can access (`/sync/v1/account`), refreshed every 30 s and on window focus so
 * new memberships and removed spaces show up without a reload.
 */
export function useSpaces() {
  const q = useQuery({
    queryKey: ['account'],
    queryFn: () => api<SyncAccount>('/sync/v1/account'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const spaces = useMemo(() => spacesOf(q.data), [q.data]);
  const byId = useCallback((apiId: string | undefined) => spaces.find((s) => s.id === (apiId ?? PERSONAL)), [spaces]);
  const rootOf = useCallback((apiId: string) => byId(apiId)?.rootId ?? spaceRootId(apiId), [byId]);
  return { spaces, byId, rootOf, isPending: q.isPending };
}

/**
 * Display name of a space: the personal space is always "My files" (translated); the others use
 * their name. `null` for the personal space with `othersOnly` (lists show only foreign spaces).
 */
export function useSpaceLabel() {
  const { t } = useTranslation();
  const { byId } = useSpaces();
  return useCallback((apiId: string | undefined, othersOnly = false): string | null => {
    const id = apiId ?? PERSONAL;
    if (id === PERSONAL) return othersOnly ? null : t('shell.myFiles');
    return byId(id)?.name ?? null;
  }, [byId, t]);
}

// ---- spaces that answered 503 space_unavailable ------------------------------------------------

const UNAVAILABLE_KEY = ['spaces', 'unavailable'] as const;

/** Records that a space's content answered 503 (`on`) or loaded again (`!on`). */
export function markSpaceUnavailable(qc: QueryClient, spaceId: string, on: boolean): void {
  const cur = qc.getQueryData<string[]>(UNAVAILABLE_KEY) ?? [];
  if (cur.includes(spaceId) === on) return;
  qc.setQueryData<string[]>(UNAVAILABLE_KEY, on ? [...cur, spaceId] : cur.filter((id) => id !== spaceId));
}

/** Ids of the spaces seen unavailable in this session (client-side state only, never fetched). */
export function useUnavailableSpaces(): string[] {
  return useQuery({ queryKey: UNAVAILABLE_KEY, queryFn: () => [] as string[], initialData: [], staleTime: Infinity }).data;
}

export const isUnavailable = (list: string[], spaceId: string) => list.includes(spaceId);

// ---- the space shown in the file browser --------------------------------------------------------

/**
 * The space of the folder open at `/files[/:folderId]`: known from the URL for space roots,
 * otherwise from the loaded folder (null while it loads, and outside the file browser).
 */
export function useCurrentSpaceId(): string | null {
  const base = useMatch('/files');
  const sub = useMatch('/files/:folderId');
  const folderId = base ? 'root' : sub?.params.folderId ?? null;
  // Observes the file browser's query without fetching it here.
  const folder = useQuery<{ folder: SyncItem }>({ queryKey: ['folder', folderId], enabled: false });
  if (!folderId) return null;
  const root = spaceIdOfRoot(folderId);
  if (root) return root;
  return folder.data ? spaceOfItem(folder.data.folder) : null;
}
