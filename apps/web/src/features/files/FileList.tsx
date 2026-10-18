import type { SyncItem } from '@synclet/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type PointerEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes, formatDate } from '@/lib/format';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { ItemDnd } from './dnd';
import { type ItemActions, ItemMenuButton } from './FileActions';
import { Thumbnail } from '@/features/preview/Thumbnail';
import { FileIcon } from './FileIcon';
import type { SortDir, SortKey } from './queries';

/** Multi-selection of a view (file browser); without it a view selects a single item. */
export interface MultiSelect {
  isSelected(id: string): boolean;
  /** Selected items; checkboxes stay visible while > 0. */
  count: number;
  /** Selection mode started with a checkbox: a touch tap toggles instead of opening. */
  selecting: boolean;
  /** Items in the list (header checkbox state). */
  total: number;
  /** Mouse/pen click. */
  onClick(item: SyncItem, mods: { toggle: boolean; range: boolean }): void;
  /** Checkbox, and a touch tap while selecting. */
  onCheck(item: SyncItem, range: boolean): void;
  /** Header checkbox: all ↔ none. */
  onCheckAll(): void;
}

export interface ViewProps {
  items: SyncItem[];
  label: string;
  /** Single mode: the selection; multi mode: the focused item (roving tabindex). */
  selectedId: string | null;
  /** Focus event. */
  onSelect(id: string): void;
  onOpen(item: SyncItem): void;
  actions: ItemActions;
  /** Absent (recent files): single selection. */
  multi?: MultiSelect;
  /** Rows/cards draggable, folders take drops (file browser only). */
  dnd?: ItemDnd;
}

/**
 * Pointer handling shared by rows and cards: mouse/pen selects on click and opens on
 * double-click; touch opens on tap (there is no double-tap on the web worth relying on).
 */
export function useItemPointer() {
  const pointer = useRef<string>('mouse');
  return {
    onPointerDown: (e: PointerEvent) => { pointer.current = e.pointerType; },
    isTouch: () => pointer.current === 'touch',
  };
}

export function itemTabIndex(item: SyncItem, index: number, selectedId: string | null) {
  return item.id === selectedId || (selectedId === null && index === 0) ? 0 : -1;
}

/** Selection checkbox of a row or card: Shift-click adds a range; never takes focus from the row. */
export function SelectBox({ item, multi, selected, className }: { item: SyncItem; multi: MultiSelect; selected: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <Checkbox
      tabIndex={-1}
      checked={selected}
      aria-label={t('files.selection.selectItem', { name: item.name })}
      // preventDefault: Radix must not toggle on its own, `checked` follows the selection only.
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); multi.onCheck(item, e.shiftKey); }}
      onDoubleClick={(e) => e.stopPropagation()}
      // No focus: the row keeps it (roving tabindex), so Space/Enter never hit the checkbox.
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(!selected && multi.count === 0 && 'opacity-0 group-hover/row:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100', className)}
    />
  );
}

/** Click on a row or card: touch opens (or toggles while selecting), mouse/pen selects. */
export function itemClick(item: SyncItem, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, isTouch: boolean, onOpen: (item: SyncItem) => void, multi?: MultiSelect) {
  if (isTouch) {
    if (multi?.selecting) multi.onCheck(item, false); else onOpen(item);
    return;
  }
  multi?.onClick(item, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
}

function SortHeader({ k, label, sort, onSort, className }: {
  k: SortKey; label: string; sort: { key: SortKey; dir: SortDir }; onSort(k: SortKey): void; className?: string;
}) {
  const { t } = useTranslation();
  const active = sort.key === k;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('h-9 px-0 text-left font-normal', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        title={t('files.sortBy', { column: label })}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          active ? 'text-foreground' : 'text-muted-foreground',
          k === 'size' && 'flex-row-reverse',
        )}
      >
        {label}
        <Arrow className={cn('size-3', active ? 'opacity-100' : 'opacity-0')} aria-hidden />
      </button>
    </th>
  );
}

export function FileList({ items, label, selectedId, onSelect, onOpen, actions, multi, dnd, sort, onSort, spaceOf }: ViewProps & {
  /** Lists across spaces (recent files): the space name shown next to an item, or null for none. */
  spaceOf?(item: SyncItem): string | null;
  sort: { key: SortKey; dir: SortDir }; onSort(k: SortKey): void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const pointer = useItemPointer();

  return (
    <table role="grid" aria-label={label} aria-rowcount={items.length + 1} aria-multiselectable={multi ? true : undefined} className="w-full table-fixed border-separate border-spacing-0 text-sm">
      <thead className="sticky top-0 z-10 bg-background">
        <tr>
          {multi && (
            <th scope="col" className="w-9 border-b pl-2 md:w-11 md:pl-4">
              <Checkbox
                tabIndex={-1}
                aria-label={t('files.selection.selectAll')}
                checked={multi.count === 0 ? false : multi.count === multi.total ? true : 'indeterminate'}
                onClick={(e) => { e.preventDefault(); multi.onCheckAll(); }}
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                className={cn(multi.count === 0 && 'opacity-60 hover:opacity-100')}
              />
            </th>
          )}
          <SortHeader k="name" label={t('files.columns.name')} sort={sort} onSort={onSort} className={multi ? 'border-b pl-0' : 'border-b pl-2 md:pl-4'} />
          <SortHeader k="modifiedAt" label={t('files.columns.modified')} sort={sort} onSort={onSort} className="hidden w-40 border-b sm:table-cell" />
          <SortHeader k="size" label={t('files.columns.size')} sort={sort} onSort={onSort} className="hidden w-28 border-b text-right sm:table-cell" />
          <th scope="col" className="w-12 border-b md:w-14"><span className="sr-only">{t('common.more')}</span></th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => {
          const selected = multi ? multi.isSelected(item.id) : item.id === selectedId;
          const size = item.type === 'folder' ? null : formatBytes(item.size, locale);
          const date = formatDate(item.modifiedAt, locale);
          return (
            <tr
              key={item.id}
              data-item-id={item.id}
              aria-rowindex={i + 2}
              aria-selected={selected}
              tabIndex={itemTabIndex(item, i, selectedId)}
              onFocus={() => onSelect(item.id)}
              onPointerDown={pointer.onPointerDown}
              onClick={(e) => itemClick(item, e, pointer.isTouch(), onOpen, multi)}
              onDoubleClick={() => onOpen(item)}
              draggable={!!dnd}
              onDragStart={dnd ? (e) => dnd.onDragStart(item, e) : undefined}
              onDragEnd={dnd?.onDragEnd}
              {...(dnd && item.type === 'folder' ? dnd.target(item) : {})}
              className={cn(
                'group/row h-12 cursor-default outline-none select-none sm:h-11',
                '[&>td]:border-b [&>td]:border-border/70 [&>td]:transition-colors [&>td]:duration-100',
                selected ? '[&>td]:bg-accent-soft' : 'hover:[&>td]:bg-accent/70',
                'focus-visible:[&>td:first-child]:shadow-[inset_2px_0_0_var(--primary)]',
                'data-[drop=over]:[&>td]:bg-primary/10',
              )}
            >
              {multi && (
                <td role="gridcell" className="pl-2 md:pl-4"><SelectBox item={item} multi={multi} selected={selected} /></td>
              )}
              <td role="gridcell" className={multi ? 'pr-2 pl-1' : 'pr-2 pl-3 md:pl-6'}>
                <div className="flex min-w-0 items-center gap-2.5">
                  <Thumbnail item={item} className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[5px] data-[thumb=loaded]:ring-1 data-[thumb=loaded]:ring-foreground/10" imgClassName="object-cover">
                    <FileIcon item={item} className="size-5" />
                  </Thumbnail>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium text-foreground" title={item.name}>{item.name}</span>
                      {spaceOf?.(item) && (
                        <span className="shrink-0 truncate rounded-sm bg-muted px-1.5 text-xs leading-5 text-muted-foreground max-w-40">{spaceOf(item)}</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground tabular-nums sm:hidden">
                      {size ? `${date}, ${size}` : date}
                    </div>
                  </div>
                </div>
              </td>
              <td role="gridcell" className="hidden px-2 text-muted-foreground tabular-nums sm:table-cell">{date}</td>
              <td role="gridcell" className="hidden px-2 text-right text-muted-foreground tabular-nums sm:table-cell">
                {size ?? <span aria-hidden>–</span>}
              </td>
              <td role="gridcell" className="pr-2 md:pr-3">
                <ItemMenuButton
                  item={item}
                  actions={actions}
                  className={cn('ml-auto flex', !selected && 'pointer-coarse:opacity-100 opacity-0 group-hover/row:opacity-100')}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
