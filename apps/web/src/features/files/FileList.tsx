import type { SyncItem } from '@synclet/shared';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { type PointerEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type ItemActions, ItemMenuButton } from './FileActions';
import { Thumbnail } from '@/features/preview/Thumbnail';
import { FileIcon } from './FileIcon';
import type { SortDir, SortKey } from './queries';

export interface ViewProps {
  items: SyncItem[];
  label: string;
  selectedId: string | null;
  onSelect(id: string): void;
  onOpen(item: SyncItem): void;
  actions: ItemActions;
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

export function FileList({ items, label, selectedId, onSelect, onOpen, actions, sort, onSort }: ViewProps & {
  sort: { key: SortKey; dir: SortDir }; onSort(k: SortKey): void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const pointer = useItemPointer();

  return (
    <table role="grid" aria-label={label} aria-rowcount={items.length + 1} className="w-full table-fixed border-separate border-spacing-0 text-sm">
      <thead className="sticky top-0 z-10 bg-background">
        <tr>
          <SortHeader k="name" label={t('files.columns.name')} sort={sort} onSort={onSort} className="border-b pl-2 md:pl-4" />
          <SortHeader k="modifiedAt" label={t('files.columns.modified')} sort={sort} onSort={onSort} className="hidden w-40 border-b sm:table-cell" />
          <SortHeader k="size" label={t('files.columns.size')} sort={sort} onSort={onSort} className="hidden w-28 border-b text-right sm:table-cell" />
          <th scope="col" className="w-12 border-b md:w-14"><span className="sr-only">{t('common.more')}</span></th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => {
          const selected = item.id === selectedId;
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
              onClick={() => { if (pointer.isTouch()) onOpen(item); }}
              onDoubleClick={() => onOpen(item)}
              className={cn(
                'group/row h-12 cursor-default outline-none select-none sm:h-11',
                '[&>td]:border-b [&>td]:border-border/70 [&>td]:transition-colors [&>td]:duration-100',
                selected ? '[&>td]:bg-accent-soft' : 'hover:[&>td]:bg-accent/70',
                'focus-visible:[&>td:first-child]:shadow-[inset_2px_0_0_var(--primary)]',
              )}
            >
              <td role="gridcell" className="pr-2 pl-3 md:pl-6">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Thumbnail item={item} className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[5px] data-[thumb=loaded]:ring-1 data-[thumb=loaded]:ring-foreground/10" imgClassName="object-cover">
                    <FileIcon item={item} className="size-5" />
                  </Thumbnail>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground" title={item.name}>{item.name}</div>
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
