import type { SyncCapabilities, SyncItem } from '@synclet/shared';
import type { DragEvent } from 'react';
import { useMemo, useRef, useState } from 'react';

/** Internal drags carry this type; the upload DropZone only reacts to `Files`. */
export const DND_MIME = 'application/x-synclet-items';

export interface DragState { ids: string[]; movable: boolean }
export interface DropTarget { id: string; capabilities: Pick<SyncCapabilities, 'addChildren'> }
export interface DropProps {
  onDragOver?(e: DragEvent<HTMLElement>): void;
  onDragLeave?(e: DragEvent<HTMLElement>): void;
  onDrop?(e: DragEvent<HTMLElement>): void;
  'data-drop'?: 'over';
}
export interface ItemDnd {
  onDragStart(item: SyncItem, e: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
  /** `{}` when `t` cannot take the current drag. */
  target(t: DropTarget): DropProps;
}

/** Invalid targets: the dragged items themselves, the current folder, folders without write access. */
export function canDrop(t: DropTarget, drag: DragState | null, currentFolderId: string): boolean {
  return !!drag && t.capabilities.addChildren && t.id !== currentFolderId && !drag.ids.includes(t.id);
}

/** ⌥ (macOS) or Ctrl copies; items that cannot be moved (read-only space) are always copied. */
export function isCopyDrop(e: { altKey: boolean; ctrlKey: boolean }, drag: DragState): boolean {
  return e.altKey || e.ctrlKey || !drag.movable;
}

/** The ids from the drag payload (`{ids}` JSON); null when it is missing or malformed. */
function dragIds(raw: string): string[] | null {
  if (!raw) return null;
  try {
    const ids = (JSON.parse(raw) as { ids?: unknown }).ids;
    return Array.isArray(ids) && ids.every((i) => typeof i === 'string') ? ids : null;
  } catch {
    return null;
  }
}

/** Drags the selection (or just the dragged item when it is not selected) onto folders and breadcrumb segments. */
export function useItemDnd({ folderId, selectedItems, label, onDrop }: {
  folderId: string; selectedItems: SyncItem[]; label(count: number): string;
  onDrop(targetId: string, ids: string[], copy: boolean): void;
}): ItemDnd {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const latest = useRef({ selectedItems, label, onDrop, drag });
  latest.current = { selectedItems, label, onDrop, drag };

  return useMemo<ItemDnd>(() => ({
    onDragStart(item, e) {
      const sel = latest.current.selectedItems;
      const items = sel.some((i) => i.id === item.id) ? sel : [item];
      const state = { ids: items.map((i) => i.id), movable: items.every((i) => i.capabilities.move) };
      e.dataTransfer.setData(DND_MIME, JSON.stringify({ ids: state.ids }));
      e.dataTransfer.effectAllowed = 'copyMove';
      // Drag image: a small pill with the count instead of the browser's snapshot of the row.
      const ghost = document.createElement('div');
      ghost.textContent = latest.current.label(items.length);
      ghost.className = 'fixed -top-40 left-0 rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground shadow-md';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      window.setTimeout(() => ghost.remove(), 0);
      latest.current.drag = state;
      setDrag(state);
    },
    onDragEnd() { latest.current.drag = null; setDrag(null); setOver(null); },
    target(t) {
      if (!canDrop(t, drag, folderId)) return {};
      return {
        onDragOver(e) {
          if (!Array.from(e.dataTransfer.types).includes(DND_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = isCopyDrop(e, drag!) ? 'copy' : 'move';
          setOver(t.id);
        },
        onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === t.id ? null : o)); },
        onDrop(e) {
          // Only internal drags: a drop of OS files after a cancelled internal drag (no dragend) must not
          // replay the stale drag state; the upload DropZone takes those.
          if (!Array.from(e.dataTransfer.types).includes(DND_MIME)) return;
          e.preventDefault();
          const d = latest.current.drag;
          setOver(null);
          setDrag(null);
          latest.current.drag = null;
          const ids = dragIds(e.dataTransfer.getData(DND_MIME)) ?? d?.ids;
          if (!ids?.length) return;
          // `movable` is only known from our own drag state; without it, copy (never fails on read-only sources).
          const state = { ids, movable: !!d?.movable && ids.every((id) => d.ids.includes(id)) };
          latest.current.onDrop(t.id, ids, isCopyDrop(e, state));
        },
        ...(over === t.id ? { 'data-drop': 'over' as const } : {}),
      };
    },
  }), [drag, over, folderId]);
}
