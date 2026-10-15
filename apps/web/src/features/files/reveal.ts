import type { SyncItem } from '@synclet/shared';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { folderPath, ROOT_ID } from './queries';

/** Query parameter naming the file to show once its folder has loaded (`/files/d_…?preview=f_…`). */
export const PREVIEW_PARAM = 'preview';

/**
 * Where an item lives in the file browser: a folder opens itself, a file opens its parent
 * folder with `?preview=<id>` so the browser selects it (and previews it, where supported).
 */
export function revealUrl(item: Pick<SyncItem, 'id' | 'type' | 'parentId'>): string {
  if (item.type === 'folder') return folderPath(item.id);
  return `${folderPath(item.parentId ?? ROOT_ID)}?${PREVIEW_PARAM}=${encodeURIComponent(item.id)}`;
}

/**
 * Handles `?preview=<id>` in a folder view: once `items` contain the item, `onReveal(item)` runs
 * once and the parameter is removed (replace, so Back does not reveal again). If the item is
 * still missing after the folder finished loading (`settled`), the parameter is dropped.
 */
export function useRevealParam(items: SyncItem[] | undefined, settled: boolean, onReveal: (item: SyncItem) => void): void {
  const [params, setParams] = useSearchParams();
  const id = params.get(PREVIEW_PARAM);
  const cb = useRef(onReveal);
  cb.current = onReveal;
  useEffect(() => {
    if (!id || !items) return;
    const item = items.find((i) => i.id === id);
    if (!item && !settled) return; // a stale cached listing may not have it yet
    setParams((p) => { const next = new URLSearchParams(p); next.delete(PREVIEW_PARAM); return next; }, { replace: true });
    if (item) cb.current(item);
  }, [id, items, settled, setParams]);
}
