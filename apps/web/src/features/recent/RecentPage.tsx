import type { SyncItem } from '@synclet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { type KeyboardEvent, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useTopbar } from '@/components/app-shell/Topbar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { errorKey } from '@/features/files/errors';
import { canShare, type ItemActions } from '@/features/files/FileActions';
import { openOfficeTab } from '@/features/office/office';
import { useCapabilities } from '@/features/office/queries';
import { FileList } from '@/features/files/FileList';
import { type SortDir, type SortKey, sortItems, useFileMutations } from '@/features/files/queries';
import { revealUrl } from '@/features/files/reveal';
import { useSpaceLabel } from '@/features/spaces/useSpaces';
import { ApiError, api } from '@/lib/api';

const RenameDialog = lazy(() => import('@/features/files/RenameDialog').then((m) => ({ default: m.RenameDialog })));
const MoveDialog = lazy(() => import('@/features/files/MoveDialog').then((m) => ({ default: m.MoveDialog })));
const DeleteDialog = lazy(() => import('@/features/files/DeleteDialog').then((m) => ({ default: m.DeleteDialog })));
const VersionsPanel = lazy(() => import('@/features/versions/VersionsPanel').then((m) => ({ default: m.VersionsPanel })));
const ShareDialog = lazy(() => import('@/features/shares/ShareDialog').then((m) => ({ default: m.ShareDialog })));

export const RECENT_LIMIT = 100;

/** The caller's most recently modified files, newest first. */
export function useRecent() {
  return useQuery({
    queryKey: ['recent'],
    queryFn: () => api<SyncItem[]>(`/sync/v1/recent?limit=${RECENT_LIMIT}`),
    refetchInterval: 30_000,
  });
}

const notify = {
  success: (msg: string) => toast.success(msg, { position: 'bottom-center' }),
  error: (msg: string) => toast.error(msg, { position: 'bottom-center' }),
};

type DialogState = { kind: 'rename' | 'move' | 'delete' | 'share' | 'versions'; item: SyncItem };

/**
 * Recently modified files across all folders, in the file browser's list view. Opening a file
 * (double-click, Enter) shows it in its folder; the menu offers the usual actions.
 */
export function RecentPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const recent = useRecent();
  const mutations = useFileMutations();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'modifiedAt', dir: 'desc' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<(DialogState & { open: boolean; n: number }) | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const items = useMemo(() => (recent.data ? sortItems(recent.data, sort.key, sort.dir, i18n.language) : []), [recent.data, sort, i18n.language]);
  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('shell.recent')} – Synclet`;
    return () => { document.title = prev; };
  }, [t]);

  const focusItem = useCallback((id: string) => {
    setSelectedId(id);
    const el = viewRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  }, []);
  const restoreFocus = () => { const sel = selectedRef.current; if (sel) focusItem(sel); };

  const patch = (fn: (list: SyncItem[]) => SyncItem[]) => qc.setQueryData<SyncItem[]>(['recent'], (d) => (d ? fn(d) : d));
  const neighborOf = (item: SyncItem) => {
    const i = items.findIndex((x) => x.id === item.id);
    return (items[i + 1] ?? items[i - 1])?.id ?? null;
  };

  const openDialog = (d: DialogState) => { setSelectedId(d.item.id); setDialog((cur) => ({ ...d, open: true, n: (cur?.n ?? 0) + 1 })); };
  const onDialogOpenChange = (o: boolean) => { if (!o) setDialog((cur) => (cur ? { ...cur, open: false } : cur)); };

  /** Shows the file in its folder (selected there; previewed where the folder view supports it). */
  const reveal = (item: SyncItem) => navigate(revealUrl(item));
  const download = (item: SyncItem) => {
    mutations.download(item).catch((err: unknown) => notify.error(err instanceof ApiError ? t(errorKey(err)) : t('files.toast.downloadFailed')));
  };
  const capabilities = useCapabilities();
  const office = capabilities.office.enabled;
  const spaceLabel = useSpaceLabel();
  const actions: ItemActions = {
    open: download,
    openInOffice: office ? (item) => openOfficeTab(item.id) : undefined,
    rename: (item) => { if (item.capabilities.rename) openDialog({ kind: 'rename', item }); },
    move: (item) => { if (item.capabilities.move) openDialog({ kind: 'move', item }); },
    remove: (item) => { if (item.capabilities.delete) openDialog({ kind: 'delete', item }); },
    share: (item) => { if (canShare(item)) openDialog({ kind: 'share', item }); },
    versions: capabilities.versions ? (item) => openDialog({ kind: 'versions', item }) : undefined,
  };

  const onSort = (key: SortKey) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target) || target.closest('button, input, textarea, [role="menu"]')) return;
    if (e.altKey || ((e.ctrlKey || e.metaKey) && e.key !== 'Backspace')) return;
    const idx = items.findIndex((i) => i.id === selectedId);
    const sel = idx >= 0 ? items[idx] : null;
    const go = (i: number) => { if (items.length) focusItem(items[Math.min(items.length - 1, Math.max(0, i))].id); };
    switch (e.key) {
      case 'ArrowDown': go(idx < 0 ? 0 : idx + 1); break;
      case 'ArrowUp': go(idx < 0 ? 0 : idx - 1); break;
      case 'Home': go(0); break;
      case 'End': go(items.length - 1); break;
      case 'Enter': if (!sel) return; reveal(sel); break;
      case 'F2': if (!sel) return; actions.rename(sel); break;
      case 'Delete': case 'Backspace': if (!sel) return; actions.remove(sel); break;
      case 'Escape': if (!sel) return; setSelectedId(null); break;
      default: return;
    }
    e.preventDefault();
  }

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('recent.title')}</h1>
      {selectedItem && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => reveal(selectedItem)}
              aria-label={t('recent.revealItem', { name: selectedItem.name })}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <FolderOpen /><span className="max-lg:hidden">{t('recent.reveal')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('recent.revealItem', { name: selectedItem.name })}</TooltipContent>
        </Tooltip>
      )}
    </>,
  );

  let body;
  if (!recent.data && recent.error) {
    body = (
      <StatusMessage title={t('recent.loadError')} body={t(errorKey(recent.error))}>
        <Button variant="outline" onClick={() => void recent.refetch()} disabled={recent.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!recent.data) {
    body = <SkeletonRows view="list" />;
  } else if (items.length === 0) {
    body = (
      <div className="p-4 md:p-6">
        <div className="flex min-h-[min(26rem,60dvh)] flex-col items-start justify-end rounded-2xl border border-dashed border-foreground/15 p-6 md:p-10">
          <h2 className="text-2xl font-semibold text-foreground">{t('recent.emptyTitle')}</h2>
          <p className="mt-2 max-w-[46ch] text-base text-muted-foreground">{t('recent.emptyBody')}</p>
          <Button variant="outline" className="mt-6" asChild><Link to="/files">{t('recent.emptyAction')}</Link></Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-1 flex-col pb-28">
        <FileList
          items={items}
          label={t('recent.title')}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={reveal}
          actions={actions}
          sort={sort}
          onSort={onSort}
          spaceOf={(item) => spaceLabel(item.spaceId, true)}
        />
        <p className="px-4 pt-4 text-xs text-muted-foreground tabular-nums md:px-6">
          {items.length >= RECENT_LIMIT ? t('recent.limitNote', { count: RECENT_LIMIT }) : t('files.fileCount', { count: items.length })}
        </p>
      </div>
    );
  }

  const d = dialog;
  return (
    <div className="flex min-h-full flex-col">
      <div
        ref={viewRef}
        className="flex flex-1 flex-col"
        onKeyDown={onKeyDown}
        onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-item-id], button, [role="menu"]')) setSelectedId(null); }}
      >
        {body}
      </div>
      <Suspense fallback={null}>
        {d?.kind === 'rename' && (
          <RenameDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            item={d.item}
            onRename={async (name) => {
              const updated = await mutations.rename.mutateAsync({ item: d.item, name });
              patch((list) => list.map((i) => (i.id === updated.id ? updated : i)));
              return updated;
            }}
          />
        )}
        {d?.kind === 'move' && (
          <MoveDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            item={d.item}
            expandedIds={[]}
            onMove={async (target) => {
              const moved = await mutations.move.mutateAsync({ item: d.item, targetId: target.id });
              patch((list) => list.map((i) => (i.id === moved.id ? moved : i)));
              notify.success(t('files.toast.moved', { name: d.item.name, target: target.name }));
            }}
          />
        )}
        {d?.kind === 'delete' && (
          <DeleteDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            item={d.item}
            onDelete={async () => {
              const next = neighborOf(d.item);
              await mutations.remove.mutateAsync(d.item);
              patch((list) => list.filter((i) => i.id !== d.item.id));
              setSelectedId(next);
              notify.success(t('files.toast.deleted', { name: d.item.name }));
            }}
          />
        )}
        {d?.kind === 'versions' && (
          <VersionsPanel key={d.n} open={d.open} onOpenChange={onDialogOpenChange} onClosed={restoreFocus} item={d.item} />
        )}
        {d?.kind === 'share' && (
          <ShareDialog key={d.n} open={d.open} onOpenChange={onDialogOpenChange} onClosed={restoreFocus} item={d.item} />
        )}
      </Suspense>
    </div>
  );
}
