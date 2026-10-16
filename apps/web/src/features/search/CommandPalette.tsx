import type { SearchHit, SyncItem } from '@synclet/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Clock, CornerDownLeft, FolderSearch, LoaderCircle, Search, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch, useNavigate } from 'react-router';
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { FileIcon, fileKind, kindStyle } from '@/features/files/FileIcon';
import { errorKey } from '@/features/files/errors';
import { ROOT_ID } from '@/features/files/queries';
import { revealUrl } from '@/features/files/reveal';
import { Thumbnail } from '@/features/preview/Thumbnail';
import { useSpaceLabel } from '@/features/spaces/useSpaces';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Highlighted } from './Highlighted';
import { nameSegments, snippetSegments } from './highlight';
import {
  addRecentSearch, clearRecentSearches, groupHits, MAX_QUERY_LENGTH, pathSegments, readRecentSearches, useSearch,
} from './queries';

/** Next active option for an arrow key; wraps around at both ends. -1 = no options. */
export function stepActive(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

type Option =
  | { kind: 'recent'; key: string; query: string }
  | { kind: 'hit'; key: string; hit: SearchHit };

export interface PaletteScope { id: string; name: string }

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Topbar search: a field-like trigger (an icon below `sm`) plus the global ⌘K / Ctrl+K shortcut,
 * both opening the command palette. Inside a folder the palette offers to search only there.
 */
export function SearchLauncher() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const match = useMatch('/files/:folderId');
  const folderId = match?.params.folderId && match.params.folderId !== ROOT_ID && /^[dr]_/.test(match.params.folderId) ? match.params.folderId : null;
  const folder = useQuery({
    queryKey: ['item', folderId],
    queryFn: () => api<SyncItem>(`/sync/v1/items/${folderId}`),
    enabled: open && !!folderId,
    staleTime: 30_000,
  });
  const scope = folderId && folder.data ? { id: folderId, name: folder.data.name } : null;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shortcut = isMac() ? '⌘K' : 'Ctrl K';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('search.open')}
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
        className={cn(
          'group flex h-8 shrink-0 items-center gap-2 rounded-md text-muted-foreground outline-none transition-colors duration-150',
          'focus-visible:ring-3 focus-visible:ring-ring/50',
          'w-8 justify-center hover:bg-muted hover:text-foreground',
          'sm:w-44 sm:justify-start sm:bg-muted/70 sm:pr-1.5 sm:pl-2.5 sm:ring-1 sm:ring-border/80 lg:w-60',
        )}
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate text-left text-sm max-sm:hidden">{t('search.placeholderShort')}</span>
        <kbd className="rounded-sm border bg-background px-1.5 font-sans text-[11px] leading-[18px] font-medium text-muted-foreground max-sm:hidden">{shortcut}</kbd>
      </button>
      {user && <CommandPalette open={open} onOpenChange={setOpen} scope={scope} userId={user.id} />}
    </>
  );
}

export function CommandPalette({ open, onOpenChange, scope, userId }: {
  open: boolean; onOpenChange(open: boolean): void; scope: PaletteScope | null; userId: string;
}) {
  const { t } = useTranslation();
  /** Set when a result was opened: focus then belongs to the destination, not the trigger. */
  const navigated = useRef(false);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (o) navigated.current = false; onOpenChange(o); }}>
      <DialogPortal>
        <DialogOverlay className="bg-black/20" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => { if (navigated.current) e.preventDefault(); }}
          className={cn(
            'fixed top-2 left-1/2 z-50 flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-[40rem] -translate-x-1/2 flex-col overflow-hidden',
            'rounded-2xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none',
            'sm:top-[12dvh] sm:max-h-[min(38rem,76dvh)]',
            'duration-150 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-2 data-closed:animate-out data-closed:fade-out-0',
          )}
        >
          <DialogPrimitive.Title className="sr-only">{t('search.title')}</DialogPrimitive.Title>
          <PaletteBody scope={scope} userId={userId} close={(nav) => { navigated.current = nav; onOpenChange(false); }} />
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

function PaletteBody({ scope, userId, close }: { scope: PaletteScope | null; userId: string; close(navigated: boolean): void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const baseId = useId();
  const [query, setQuery] = useState('');
  const [inFolder, setInFolder] = useState(false);
  const [recents, setRecents] = useState(() => readRecentSearches(userId));
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const folderId = inFolder && scope ? scope.id : null;
  const search = useSearch(query, folderId);
  const typed = query.trim().length > 0;
  const hits = typed ? search.data?.hits ?? [] : [];
  const groups = groupHits(hits);

  // Keyboard order = visual order: names first, then contents.
  const options: Option[] = typed
    ? [...groups.names, ...groups.contents].map((hit) => ({ kind: 'hit', key: hit.item.id, hit }))
    : recents.map((q) => ({ kind: 'recent', key: `recent:${q}`, query: q }));
  const optionKeys = options.map((o) => o.key).join('\n');
  // A new result list starts on its first entry; recent searches start unselected.
  useEffect(() => { setActive(typed && optionKeys ? 0 : -1); }, [optionKeys, typed]);

  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const activeId = active >= 0 ? optionId(active) : undefined;
  useEffect(() => {
    const el = activeId ? document.getElementById(activeId) : null;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  function choose(o: Option) {
    if (o.kind === 'recent') {
      setQuery(o.query);
      inputRef.current?.focus();
      return;
    }
    setRecents(addRecentSearch(userId, query));
    close(true);
    navigate(revealUrl(o.hit.item));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown': setActive((a) => stepActive(a, 1, options.length)); break;
      case 'ArrowUp': setActive((a) => stepActive(a, -1, options.length)); break;
      case 'Enter': {
        const o = options[active];
        if (!o) return;
        // The list still shows the previous query's (or scope's) hits: wait for the new ones.
        if (o.kind === 'hit' && search.stale) { e.preventDefault(); return; }
        choose(o);
        break;
      }
      default: return;
    }
    e.preventDefault();
  }

  const renderOption = (o: Option, i: number) => {
    return (
      <OptionRow key={o.key} id={optionId(i)} active={i === active} onHover={() => setActive(i)} onChoose={() => choose(o)}>
        {o.kind === 'recent' ? <RecentRow query={o.query} /> : <HitRow hit={o.hit} query={search.settledQuery} />}
      </OptionRow>
    );
  };

  let body: ReactNode;
  /** Whether `body` is options (inside the listbox) or a notice (outside it). */
  let isList = false;
  if (!typed) {
    isList = recents.length > 0;
    body = recents.length > 0 ? (
      <Group label={t('search.recentSearches')} id={`${baseId}-recent`}>
        {options.map((o, i) => renderOption(o, i))}
      </Group>
    ) : (
      <Notice title={t('search.emptyTitle')} body={t('search.emptyBody')} />
    );
  } else if (search.isError && !search.data) {
    body = (
      <Notice title={t('search.errorTitle')} body={t(errorKey(search.error))}>
        <button type="button" onClick={() => void search.refetch()} className="text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline">
          {t('common.retry')}
        </button>
      </Notice>
    );
  } else if (!search.data) {
    body = <ResultSkeleton />;
  } else if (hits.length === 0 && !search.pending) {
    body = (
      <Notice title={t('search.noResultsTitle', { query: search.settledQuery })} body={folderId ? t('search.noResultsInFolder', { name: scope?.name }) : t('search.noResultsBody')}>
        {folderId && (
          <button type="button" onClick={() => setInFolder(false)} className="text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline">
            {t('search.searchEverywhere')}
          </button>
        )}
      </Notice>
    );
  } else {
    isList = true;
    body = (
      <>
        {groups.names.length > 0 && (
          <Group label={t('search.groupNames')} id={`${baseId}-names`}>
            {options.slice(0, groups.names.length).map((o, i) => renderOption(o, i))}
          </Group>
        )}
        {groups.contents.length > 0 && (
          <Group label={t('search.groupContents')} id={`${baseId}-contents`}>
            {options.slice(groups.names.length).map((o, i) => renderOption(o, groups.names.length + i))}
          </Group>
        )}
      </>
    );
  }

  const total = search.data?.total ?? 0;
  /** Footer content beyond the key hints (those are hidden on phones). */
  const footerExtras = typed ? total > 0 : recents.length > 0;
  const listboxId = `${baseId}-list`;
  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-3 px-4">
        {search.pending && typed
          ? <LoaderCircle className="size-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          : <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />}
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={isList ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label={t('search.title')}
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={folderId ? t('search.placeholderIn', { name: scope?.name }) : t('search.placeholder')}
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/80"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            aria-label={t('search.clear')}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      {scope && (
        <div className="flex shrink-0 items-center gap-1 border-t px-3 py-1.5 text-xs">
          <span className="pr-1 pl-1 text-muted-foreground">{t('search.scopeLabel')}</span>
          <ScopeChip pressed={!inFolder} onClick={() => setInFolder(false)}>{t('search.scopeAll')}</ScopeChip>
          <ScopeChip pressed={inFolder} onClick={() => setInFolder(true)}>
            <FolderSearch className="size-3.5 shrink-0" />
            <span className="truncate">{t('search.scopeFolder', { name: scope.name })}</span>
          </ScopeChip>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t p-1.5">
        {isList ? <div id={listboxId} role="listbox" aria-label={t('search.results')}>{body}</div> : body}
      </div>
      <footer className={cn('flex shrink-0 items-center gap-4 border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground', !footerExtras && 'max-sm:hidden')}>
        <span className="flex items-center gap-1.5 max-sm:hidden"><Kbd>↑</Kbd><Kbd>↓</Kbd>{t('search.hintMove')}</span>
        <span className="flex items-center gap-1.5 max-sm:hidden"><Kbd><CornerDownLeft className="size-3" /></Kbd>{t('search.hintOpen')}</span>
        <span className="flex items-center gap-1.5 max-sm:hidden"><Kbd>esc</Kbd>{t('search.hintClose')}</span>
        {!typed && recents.length > 0 && (
          // Outside the listbox: a listbox may only contain options.
          <button
            type="button"
            className="ml-auto rounded-sm px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => { clearRecentSearches(userId); setRecents([]); inputRef.current?.focus(); }}
          >
            {t('search.clearRecent')}
          </button>
        )}
        {typed && search.data && total > 0 && (
          <span className="ml-auto tabular-nums" aria-live="polite">
            {total > hits.length ? t('search.countOf', { count: hits.length, total }) : t('search.count', { count: total })}
          </span>
        )}
      </footer>
    </>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border bg-background px-1 font-sans text-[11px] font-medium text-muted-foreground">{children}</kbd>;
}

function ScopeChip({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full px-2.5 font-medium outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50',
        pressed ? 'bg-accent-soft text-foreground ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Group({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="pb-1 not-first:mt-1">
      <div id={id} role="presentation" className="flex h-7 items-center px-2.5 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function OptionRow({ id, active, onHover, onChoose, children }: {
  id: string; active: boolean; onHover(): void; onChoose(): void; children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseMove={() => { if (!active) onHover(); }}
      // Keep focus in the input: the listbox is driven by aria-activedescendant.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
      className={cn('group/opt flex cursor-default items-start gap-3 rounded-lg px-2.5 py-2', active && 'bg-accent-soft')}
    >
      {children}
      <CornerDownLeft aria-hidden className={cn('mt-1.5 size-3.5 shrink-0 text-muted-foreground', !active && 'invisible')} />
    </div>
  );
}

function RecentRow({ query }: { query: string }) {
  return (
    <>
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm">{query}</span>
    </>
  );
}

function HitRow({ hit, query }: { hit: SearchHit; query: string }) {
  const { item } = hit;
  const spaceLabel = useSpaceLabel();
  // The path is relative to the hit's space root: "My files" or the space name comes first.
  const location = [spaceLabel(item.spaceId) ?? '…', ...pathSegments(hit.path)];
  const kind = fileKind(item);
  return (
    <>
      <span style={kindStyle(kind)} className="shrink-0">
        <Thumbnail
          item={item}
          className="flex size-8 items-center justify-center overflow-hidden rounded-md bg-(--ft)/10 data-[thumb=loaded]:ring-1 data-[thumb=loaded]:ring-foreground/10"
          imgClassName="object-cover"
        >
          <FileIcon item={item} className="size-4.5" />
        </Thumbnail>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground" title={item.name}>
          <Highlighted segments={nameSegments(item.name, query)} />
        </span>
        <span className="flex min-w-0 items-center gap-0.5 text-xs text-muted-foreground" title={location.join(' / ')}>
          {location.map((seg, i, all) => (
            <span key={i} className={cn('flex min-w-0 items-center gap-0.5', i < all.length - 1 && i > 0 && 'max-w-[10rem] shrink')}>
              {i > 0 && <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />}
              <span className="truncate">{seg}</span>
            </span>
          ))}
        </span>
        {hit.snippet && (
          <span className="mt-1 line-clamp-2 border-l-2 border-border pl-2 text-xs leading-[18px] text-muted-foreground">
            <Highlighted segments={snippetSegments(hit.snippet)} markClassName="font-medium" />
          </span>
        )}
      </span>
    </>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center" role="status">
      <p className="text-base font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-[42ch] text-sm text-muted-foreground">{body}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div aria-hidden className="p-1">
      {['w-48', 'w-64', 'w-40'].map((w) => (
        <div key={w} className="flex items-center gap-3 px-2.5 py-2">
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1">
            <Skeleton className={cn('h-3.5', w)} />
            <Skeleton className="mt-1.5 h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}
