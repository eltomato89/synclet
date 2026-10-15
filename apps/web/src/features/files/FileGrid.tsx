import { useTranslation } from 'react-i18next';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ItemMenuButton } from './FileActions';
import { FileIcon, fileKind, kindStyle } from './FileIcon';
import { itemTabIndex, useItemPointer, type ViewProps } from './FileList';

export function FileGrid({ items, label, selectedId, onSelect, onOpen, actions }: ViewProps) {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const pointer = useItemPointer();

  return (
    <ul
      role="listbox"
      aria-label={label}
      data-view="grid"
      className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 px-4 pt-4 md:px-6 md:pt-5"
    >
      {items.map((item, i) => {
        const selected = item.id === selectedId;
        return (
          <li
            key={item.id}
            role="option"
            data-item-id={item.id}
            aria-selected={selected}
            tabIndex={itemTabIndex(item, i, selectedId)}
            onFocus={() => onSelect(item.id)}
            onPointerDown={pointer.onPointerDown}
            onClick={() => { if (pointer.isTouch()) onOpen(item); }}
            onDoubleClick={() => onOpen(item)}
            className={cn(
              'group/card relative flex cursor-default flex-col rounded-xl border p-1.5 outline-none select-none transition-colors duration-100',
              'focus-visible:ring-3 focus-visible:ring-ring/50',
              selected ? 'border-primary/40 bg-accent-soft' : 'border-transparent hover:bg-accent/70',
            )}
          >
            <div
              style={kindStyle(fileKind(item))}
              className="flex aspect-[4/3] items-center justify-center rounded-lg bg-(--ft)/8 dark:bg-(--ft)/12"
            >
              <FileIcon item={item} strokeWidth={1.25} className="size-12" />
            </div>
            <div className="min-w-0 px-1 pt-2 pb-0.5">
              <div className="truncate text-sm font-medium" title={item.name}>{item.name}</div>
              <div className="truncate text-xs text-muted-foreground tabular-nums">
                {item.type === 'folder' ? formatDate(item.modifiedAt, locale) : formatBytes(item.size, locale)}
              </div>
            </div>
            <ItemMenuButton
              item={item}
              actions={actions}
              className={cn(
                'absolute top-2.5 right-2.5 bg-background/80 backdrop-blur-sm',
                !selected && 'pointer-coarse:opacity-100 opacity-0 group-hover/card:opacity-100',
              )}
            />
          </li>
        );
      })}
    </ul>
  );
}
