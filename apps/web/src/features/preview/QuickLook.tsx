import { ChevronLeft, ChevronRight, Download, FilePen, History, Share2, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type ComponentProps, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileIcon } from '@/features/files/FileIcon';
import { isOfficeFile } from '@/features/office/office';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { stepEntry } from './navigation';
import type { PreviewSource } from './source';
import { PreviewStage } from './viewers';
import { Loading, NoPreview } from './viewers/common';

export interface QuickLookEntry { id: string; name: string; size: number; mime: string | null; modifiedAt?: string }

export interface QuickLookProps<E extends QuickLookEntry> {
  /** Files in display order; the arrows step through them. */
  entries: readonly E[];
  activeId: string;
  open: boolean;
  onActiveChange(id: string): void;
  onOpenChange(open: boolean): void;
  /** After the close animation, with the file shown last (to move focus back to it). */
  onClosed?(lastId: string): void;
  /** Builds the viewer source (URLs, text loader) for an entry. */
  resolveSource(entry: E): Promise<PreviewSource>;
  onDownload?(entry: E): void;
  onShare?(entry: E): void;
  /** Set when office editing is available; offered for office files. */
  onOpenInOffice?(entry: E): void;
  /** Set when versions are enabled; opens the versions panel for the file. */
  onVersions?(entry: E): void;
}

type Resolved = { id: string; source: PreviewSource } | { id: string; error: true };

/**
 * QuickLook: full-screen preview on a dark stage, so photos read true and documents float as a
 * page. Header with name, size, date and actions; ←/→ step through the siblings in the current
 * sort order, Space or Esc closes. Focus is trapped while open and handed back via `onClosed`.
 */
export function QuickLook<E extends QuickLookEntry>(props: QuickLookProps<E>) {
  const { entries, activeId, open, onActiveChange, onOpenChange, onClosed, resolveSource, onDownload, onShare, onOpenInOffice, onVersions } = props;
  const { t, i18n } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  // The entry stays displayable if it vanishes from the list (deleted elsewhere) while open.
  const lastEntry = useRef<E | null>(null);
  const entry = entries.find((e) => e.id === activeId) ?? (lastEntry.current?.id === activeId ? lastEntry.current : null);
  lastEntry.current = entry;
  const index = entries.findIndex((e) => e.id === activeId);
  const prev = stepEntry(entries, activeId, -1);
  const next = stepEntry(entries, activeId, 1);

  const [resolved, setResolved] = useState<Resolved | null>(null);
  const resolveRef = useRef(resolveSource);
  resolveRef.current = resolveSource;
  useEffect(() => {
    if (!entry) return;
    let live = true;
    resolveRef.current(entry).then(
      (source) => { if (live) setResolved({ id: entry.id, source }); },
      () => { if (live) setResolved({ id: entry.id, error: true }); },
    );
    return () => { live = false; };
    // Resolve per entry id: polling hands in new objects for the same file.
  }, [entry?.id]);

  // Warm up the neighbours: their tokens, and the picture the image viewer shows first.
  useEffect(() => {
    if (!open || resolved?.id !== activeId) return;
    for (const n of [next, prev]) {
      if (!n) continue;
      resolveRef.current(n).then((s) => {
        const url = s.kind === 'image' ? s.thumbnailUrl(1024) ?? (s.rasterSafe ? s.contentUrl : null) : null;
        if (url) new Image().src = url;
      }, () => { /* best effort */ });
    }
  }, [open, resolved?.id, activeId, next?.id, prev?.id]);

  const go = (target: E | null) => { if (target) onActiveChange(target.id); };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (e.altKey || e.ctrlKey || e.metaKey || target.closest('video, audio, input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'ArrowLeft') go(prev);
    else if (e.key === 'ArrowRight') go(next);
    else if (e.key === ' ' && !target.closest('button, a')) onOpenChange(false);
    else return;
    e.preventDefault();
  }

  const current = resolved && resolved.id === activeId ? resolved : null;
  const download = entry && onDownload ? () => onDownload(entry) : undefined;
  let stage: ReactNode;
  if (!entry) stage = null;
  else if (!current) stage = <Loading className="size-full" />;
  else if ('error' in current) stage = <NoPreview source={fallbackSource(entry)} failed onDownload={download} />;
  else stage = <PreviewStage key={entry.id} source={current.source} onDownload={download} />;

  const date = entry?.modifiedAt
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.modifiedAt))
    : null;
  const size = entry ? formatBytes(entry.size, i18n.language) : '';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-(--stage) backdrop-blur-xl duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Content
          ref={contentRef}
          data-slot="quicklook"
          onOpenAutoFocus={(e) => { e.preventDefault(); contentRef.current?.focus({ preventScroll: true }); }}
          onCloseAutoFocus={(e) => { e.preventDefault(); onClosed?.(activeId); }}
          onKeyDown={onKeyDown}
          // Full-screen: anything "outside" is another layer opened from here (the share dialog);
          // it must not close QuickLook underneath it. Esc and the close button still do.
          onFocusOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="fixed inset-0 z-50 flex flex-col text-white outline-none duration-200 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.985] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.985]"
        >
          <header className="dark flex h-14 shrink-0 items-center gap-3 pr-2 pl-4 text-foreground md:pr-3 md:pl-5">
            {entry && <FileIcon item={{ type: 'file', name: entry.name, mime: entry.mime }} className="size-5" />}
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-sm font-medium" title={entry?.name}>{entry?.name}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="truncate text-xs text-muted-foreground tabular-nums">
                {date ? t('preview.meta', { size, date }) : size}
              </DialogPrimitive.Description>
            </div>
            {entries.length > 1 && index >= 0 && (
              <span className="mr-2 text-xs text-muted-foreground tabular-nums max-sm:hidden">
                {t('preview.position', { index: index + 1, total: entries.length })}
              </span>
            )}
            <div className="flex items-center gap-0.5">
              {entry && onOpenInOffice && isOfficeFile(entry.name) && (
                <Button variant="ghost" size="sm" onClick={() => onOpenInOffice(entry)} className="mr-1 text-muted-foreground hover:text-foreground">
                  <FilePen /><span className="max-sm:sr-only">{t('office.open')}</span>
                </Button>
              )}
              {entry && onVersions && <HeaderButton label={t('files.versionsShort')} onClick={() => onVersions(entry)}><History /></HeaderButton>}
              {entry && onShare && <HeaderButton label={t('preview.share')} onClick={() => onShare(entry)}><Share2 /></HeaderButton>}
              {download && <HeaderButton label={t('common.download')} onClick={download}><Download /></HeaderButton>}
              <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />
              <DialogPrimitive.Close asChild>
                <HeaderButton label={t('preview.close')}><X /></HeaderButton>
              </DialogPrimitive.Close>
            </div>
          </header>

          <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-16 md:px-20 md:pb-8">
            {stage}
          </div>

          <NavButton side="left" label={t('preview.previous')} disabled={!prev} onClick={() => go(prev)} />
          <NavButton side="right" label={t('preview.next')} disabled={!next} onClick={() => go(next)} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function fallbackSource(entry: QuickLookEntry): PreviewSource {
  return {
    kind: 'none', name: entry.name, size: entry.size, mime: entry.mime,
    contentUrl: '', downloadUrl: null, thumbnailUrl: () => null, rasterSafe: false,
  };
}

function HeaderButton({ label, children, ...rest }: { label: string; children: ReactNode } & ComponentProps<'button'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className="text-muted-foreground hover:text-foreground" {...rest}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavButton({ side, label, disabled, onClick }: { side: 'left' | 'right'; label: string; disabled: boolean; onClick(): void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      tabIndex={-1}
      onClick={onClick}
      className={cn(
        'absolute bottom-3 z-10 flex size-10 items-center justify-center rounded-full bg-white/8 text-white/85 ring-1 ring-white/12 backdrop-blur-md outline-none transition-[background-color,opacity] duration-150',
        'hover:bg-white/16 hover:text-white focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0',
        'md:top-1/2 md:bottom-auto md:size-11 md:-translate-y-1/2',
        side === 'left' ? 'left-3 md:left-5' : 'right-3 md:right-5',
      )}
    >
      <Icon aria-hidden className="size-5" strokeWidth={1.75} />
    </button>
  );
}
