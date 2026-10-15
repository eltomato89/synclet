import type { PublicShareEntry } from '@synclet/shared';
import { ChevronRight, Download, FolderOpen, LayoutGrid, List, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FileIcon, fileKind, kindStyle } from '@/features/files/FileIcon';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { shareUrls } from './api';

export interface Crumb { id: string | null; name: string }
export type ViewMode = 'list' | 'grid';

const VIEW_KEY = 'synclet.publicShare.view';

export function useViewMode(): [ViewMode, (v: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  });
  return [view, (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } }];
}

/** Thumbnail of a file when the server has one; the tinted file-type icon otherwise or on error. */
function Thumb({ token, entry, size, className, iconClassName }: {
  token: string; entry: PublicShareEntry; size: 256; className?: string; iconClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const kind = fileKind(entry);
  if (entry.type === 'file' && entry.hasThumbnail && !failed) {
    return (
      <span className={cn('overflow-hidden bg-muted', className)}>
        <img
          src={shareUrls(token).thumbnail(entry.id, size)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      </span>
    );
  }
  return (
    <span style={kindStyle(kind)} className={cn('flex items-center justify-center bg-(--ft)/8 dark:bg-(--ft)/12', className)}>
      <FileIcon item={entry} strokeWidth={1.5} className={iconClassName} />
    </span>
  );
}

function Breadcrumbs({ trail, onNavigate }: { trail: Crumb[]; onNavigate(depth: number): void }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('publicShare.breadcrumb')} className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-0.5 text-sm">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={`${c.id ?? 'root'}-${i}`} className={cn('flex min-w-0 items-center gap-0.5', !last && i > 0 && 'max-sm:hidden')}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
              {last ? (
                <span aria-current="page" className="truncate px-1.5 font-semibold" title={c.name}>{c.name || '…'}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(i)}
                  className="truncate rounded-md px-1.5 py-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  title={c.name}
                >
                  {c.name || '…'}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function DownloadIcon({ href, name }: { href: string; name: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
      <a href={href} download aria-label={t('publicShare.downloadNamed', { name })} title={t('publicShare.download')} onClick={(e) => e.stopPropagation()}>
        <Download />
      </a>
    </Button>
  );
}

const rowButton = 'outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset';

function ListView({ token, items, allowDownload, onOpen }: ItemsProps) {
  const { t, i18n } = useTranslation();
  const urls = shareUrls(token);
  return (
    <ul aria-label={t('publicShare.contents')} className="divide-y">
      {items.map((it) => (
        <li key={it.id} className="group/row relative flex items-center gap-2 pr-2 transition-colors duration-100 hover:bg-accent/60">
          <button type="button" onClick={() => onOpen(it)} className={cn('flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left', rowButton)}>
            <Thumb token={token} entry={it} size={256} className="size-9 shrink-0 rounded-md" iconClassName="size-5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium" title={it.name}>{it.name}</span>
              <span className="block truncate text-xs text-muted-foreground tabular-nums sm:hidden">
                {it.type === 'folder' ? t('publicShare.folder') : formatBytes(it.size, i18n.language)}
              </span>
            </span>
            <span className="w-24 shrink-0 text-right text-sm text-muted-foreground tabular-nums max-sm:hidden">
              {it.type === 'folder' ? '' : formatBytes(it.size, i18n.language)}
            </span>
            <span className="w-28 shrink-0 text-right text-sm text-muted-foreground tabular-nums max-md:hidden">
              {formatDate(it.modifiedAt, i18n.language)}
            </span>
          </button>
          <span className="flex w-8 shrink-0 justify-center">
            {allowDownload && it.type === 'file' && <DownloadIcon href={urls.content(it.id, { download: true })} name={it.name} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GridView({ token, items, allowDownload, onOpen }: ItemsProps) {
  const { t, i18n } = useTranslation();
  const urls = shareUrls(token);
  return (
    <ul aria-label={t('publicShare.contents')} className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3 p-4">
      {items.map((it) => (
        <li key={it.id} className="group/card relative">
          <button
            type="button"
            onClick={() => onOpen(it)}
            className={cn('flex w-full flex-col rounded-xl border border-transparent p-1.5 text-left transition-colors duration-100 hover:bg-accent/70 outline-none focus-visible:ring-3 focus-visible:ring-ring/50')}
          >
            <Thumb token={token} entry={it} size={256} className="aspect-[4/3] w-full rounded-lg" iconClassName="size-12" />
            <span className="min-w-0 px-1 pt-2 pb-0.5">
              <span className="block truncate text-sm font-medium" title={it.name}>{it.name}</span>
              <span className="block truncate text-xs text-muted-foreground tabular-nums">
                {it.type === 'folder' ? formatDate(it.modifiedAt, i18n.language) : formatBytes(it.size, i18n.language)}
              </span>
            </span>
          </button>
          {allowDownload && it.type === 'file' && (
            <span className="absolute top-3 right-3 rounded-md bg-background/85 backdrop-blur-sm pointer-fine:opacity-0 pointer-fine:group-hover/card:opacity-100 pointer-fine:focus-within:opacity-100">
              <DownloadIcon href={urls.content(it.id, { download: true })} name={it.name} />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface ItemsProps {
  token: string;
  items: PublicShareEntry[];
  allowDownload: boolean;
  onOpen(entry: PublicShareEntry): void;
}

/** Paper panel of a folder share: breadcrumb within the share, view toggle, list or grid. */
export function FolderBrowser({ token, trail, items, loading, error, allowDownload, emptyHint, onNavigate, onOpen, onRetry }: {
  token: string;
  trail: Crumb[];
  items: PublicShareEntry[] | undefined;
  loading: boolean;
  error: string | null;
  allowDownload: boolean;
  emptyHint: ReactNode;
  onNavigate(depth: number): void;
  onOpen(entry: PublicShareEntry): void;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useViewMode();
  const current = trail[trail.length - 1];
  const inSubfolder = trail.length > 1;

  let body: ReactNode;
  if (error) {
    body = (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <p className="text-base text-muted-foreground">{error}</p>
        <Button variant="outline" className="mt-4" onClick={onRetry}><RotateCw />{t('common.retry')}</Button>
      </div>
    );
  } else if (loading || !items) {
    body = (
      <div aria-busy="true" aria-label={t('common.loading')} className="divide-y">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="h-4 w-[40%]" />
          </div>
        ))}
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <FolderOpen className="size-10 text-muted-foreground/60" strokeWidth={1.25} aria-hidden />
        <p className="mt-3 text-base font-medium">{t('publicShare.empty')}</p>
        {emptyHint && <p className="mt-1 text-sm text-muted-foreground">{emptyHint}</p>}
      </div>
    );
  } else {
    const props = { token, items, allowDownload, onOpen };
    body = view === 'grid' ? <GridView {...props} /> : <ListView {...props} />;
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex min-h-12 items-center gap-2 border-b py-1.5 pr-2 pl-2.5">
        <Breadcrumbs trail={trail} onNavigate={onNavigate} />
        {inSubfolder && allowDownload && (
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            <a href={shareUrls(token).zip(current.id)} download>
              <Download />
              <span className="max-sm:sr-only">{t('publicShare.downloadFolder')}</span>
            </a>
          </Button>
        )}
        <ToggleGroup
          type="single" size="sm" spacing={0} value={view} aria-label={t('publicShare.view')}
          onValueChange={(v) => { if (v === 'list' || v === 'grid') setView(v); }}
        >
          <ToggleGroupItem value="list" aria-label={t('publicShare.viewList')} title={t('publicShare.viewList')} className="text-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground">
            <List />
          </ToggleGroupItem>
          <ToggleGroupItem value="grid" aria-label={t('publicShare.viewGrid')} title={t('publicShare.viewGrid')} className="text-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground">
            <LayoutGrid />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {body}
    </div>
  );
}
