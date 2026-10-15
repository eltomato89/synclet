import type { SyncAccount, SyncItem } from '@synclet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, LayoutGrid, List, Plus, Share2, Upload } from 'lucide-react';
import { type KeyboardEvent, lazy, type MouseEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useTopbar } from '@/components/app-shell/Topbar';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Breadcrumbs } from '@/features/files/Breadcrumbs';
import { DropZone } from '@/features/files/DropZone';
import { EmptyState, SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { errorKey } from '@/features/files/errors';
import { BrowserContextMenu, type ItemActions } from '@/features/files/FileActions';
import { FileGrid } from '@/features/files/FileGrid';
import { FileList } from '@/features/files/FileList';
import {
  folderPath, ROOT_ID, type SortDir, type SortKey, sortItems, useAncestors, useFileMutations, useFolder,
} from '@/features/files/queries';
import { UploadPanel } from '@/features/files/UploadPanel';
import { getUploadQueue, type UploadQueue } from '@/features/files/uploads';
import { quickLookEntries } from '@/features/preview/navigation';
import { isPreviewable, syncPreviewSource } from '@/features/preview/source';
import { ApiError, api } from '@/lib/api';

const NewFolderDialog = lazy(() => import('@/features/files/NewFolderDialog').then((m) => ({ default: m.NewFolderDialog })));
const RenameDialog = lazy(() => import('@/features/files/RenameDialog').then((m) => ({ default: m.RenameDialog })));
const MoveDialog = lazy(() => import('@/features/files/MoveDialog').then((m) => ({ default: m.MoveDialog })));
const DeleteDialog = lazy(() => import('@/features/files/DeleteDialog').then((m) => ({ default: m.DeleteDialog })));
const QuickLook = lazy(() => import('@/features/preview/QuickLook').then((m) => ({ default: m.QuickLook })));
const ShareDialog = lazy(() => import('@/features/shares/ShareDialog').then((m) => ({ default: m.ShareDialog })));

const FOLDER_ID = /^(root|d_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const VIEW_KEY = 'synclet.files.view';
const SORT_KEY = 'synclet.files.sort';

type View = 'list' | 'grid';
interface Sort { key: SortKey; dir: SortDir }

function readPref<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? (v as T) : fallback;
  } catch { return fallback; }
}
function writePref(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
const isSort = (v: unknown) => !!v && typeof v === 'object'
  && ['name', 'modifiedAt', 'size'].includes((v as Sort).key) && ['asc', 'desc'].includes((v as Sort).dir);

/** File-browser toasts sit bottom-center so they never cover the upload panel. */
const notify = {
  success: (msg: string) => toast.success(msg, { position: 'bottom-center' }),
  error: (msg: string) => toast.error(msg, { position: 'bottom-center' }),
};

type DialogState = { kind: 'newFolder' } | { kind: 'rename' | 'move' | 'delete' | 'share'; item: SyncItem };

export function FilesPage() {
  const { folderId = ROOT_ID } = useParams();
  const qc = useQueryClient();
  const [queue] = useState(() => {
    // Batch refreshes: a burst of finished uploads triggers one refetch per folder.
    const pending = new Set<string>();
    let timer: number | undefined;
    return getUploadQueue((pid) => {
      pending.add(pid);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        for (const id of pending) void qc.invalidateQueries({ queryKey: ['folder', id] });
        pending.clear();
        void qc.invalidateQueries({ queryKey: ['account'] });
      }, 250);
    });
  });
  const account = useQuery({ queryKey: ['account'], queryFn: () => api<SyncAccount>('/sync/v1/account') });
  useEffect(() => { if (account.data) queue.setMaxUploadBytes(account.data.maxUploadBytes); }, [account.data, queue]);

  return (
    <>
      {FOLDER_ID.test(folderId) ? <FolderBrowser key={folderId} folderId={folderId} queue={queue} /> : <NotFound />}
      <UploadPanel queue={queue} />
    </>
  );
}

function NotFoundMessage() {
  const { t } = useTranslation();
  return (
    <StatusMessage title={t('files.notFound.title')} body={t('files.notFound.body')}>
      <Button variant="outline" asChild><Link to="/files">{t('files.notFound.back')}</Link></Button>
    </StatusMessage>
  );
}

function NotFound() {
  useTopbar(null);
  return <NotFoundMessage />;
}

function FolderBrowser({ folderId, queue }: { folderId: string; queue: UploadQueue }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const folderQ = useFolder(folderId);
  const ancestors = useAncestors(folderId);
  const mutations = useFileMutations();

  const [view, setViewState] = useState<View>(() => readPref(VIEW_KEY, 'list', (v) => v === 'list' || v === 'grid'));
  const [sort, setSort] = useState<Sort>(() => readPref(SORT_KEY, { key: 'name', dir: 'asc' }, isSort));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<(DialogState & { open: boolean; n: number }) | null>(null);
  const [menuItem, setMenuItem] = useState<SyncItem | null>(null);
  const [quickLook, setQuickLook] = useState<{ id: string; open: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const focusAfterRender = useRef<string | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const folder = folderQ.data?.folder;
  const folderName = !folder ? '' : folder.kind === 'root' ? t('shell.myFiles') : folder.name;
  const canAdd = !!folder?.capabilities.addChildren;
  const items = useMemo(
    () => (folderQ.data ? sortItems(folderQ.data.items, sort.key, sort.dir, i18n.language) : []),
    [folderQ.data, sort, i18n.language],
  );

  useEffect(() => {
    if (!folderName) return;
    const prev = document.title;
    document.title = `${folderName} – Synclet`;
    return () => { document.title = prev; };
  }, [folderName]);

  const setView = (v: View) => { setViewState(v); writePref(VIEW_KEY, v); };

  // ---- focus & selection: the focused row/card is the selection --------------------------------
  const itemEl = (id: string) => viewRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
  const focusItem = useCallback((id: string) => {
    const el = itemEl(id);
    setSelectedId(id);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
    else focusAfterRender.current = id; // not rendered yet (e.g. just created)
  }, []);
  useEffect(() => {
    const id = focusAfterRender.current;
    const el = id ? itemEl(id) : null;
    if (el) { focusAfterRender.current = null; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  });
  /** After a dialog closes, focus goes back to the selection so the keyboard keeps working. */
  const restoreFocus = () => {
    const sel = selectedRef.current;
    if (sel) focusItem(sel);
    else viewRef.current?.querySelector<HTMLElement>('[data-item-id]')?.focus({ preventScroll: true });
  };

  // ---- cache helpers: instant feedback, the invalidation refetch confirms ----------------------
  const patchItems = (fn: (list: SyncItem[]) => SyncItem[]) =>
    qc.setQueryData<{ folder: SyncItem; items: SyncItem[] }>(['folder', folderId], (d) => (d ? { ...d, items: fn(d.items) } : d));
  const neighborOf = (item: SyncItem) => {
    const i = items.findIndex((x) => x.id === item.id);
    return (items[i + 1] ?? items[i - 1])?.id ?? null;
  };

  // ---- actions --------------------------------------------------------------------------------
  const openDialog = (d: DialogState) => setDialog((cur) => ({ ...d, open: true, n: (cur?.n ?? 0) + 1 }));
  const onDialogOpenChange = (o: boolean) => { if (!o) setDialog((cur) => (cur ? { ...cur, open: false } : cur)); };

  const download = (item: SyncItem) => {
    mutations.download(item).catch((err: unknown) => notify.error(err instanceof ApiError ? t(errorKey(err)) : t('files.toast.downloadFailed')));
  };
  const open = (item: SyncItem) => {
    if (item.type === 'folder') navigate(folderPath(item.id));
    else download(item);
  };
  const preview = (item: SyncItem) => {
    if (item.type !== 'file') return;
    setSelectedId(item.id);
    setQuickLook({ id: item.id, open: true });
  };
  /** Double-click / tap: folders open, previewable files show QuickLook, anything else downloads. */
  const activate = (item: SyncItem) => { if (isPreviewable(item)) preview(item); else open(item); };
  const quickLookFiles = useMemo(() => quickLookEntries(items), [items]);
  const actions: ItemActions = {
    open,
    preview,
    rename: (item) => { setSelectedId(item.id); if (item.capabilities.rename) openDialog({ kind: 'rename', item }); },
    move: (item) => { setSelectedId(item.id); if (item.capabilities.move) openDialog({ kind: 'move', item }); },
    remove: (item) => { setSelectedId(item.id); if (item.capabilities.delete) openDialog({ kind: 'delete', item }); },
    share: (item) => { setSelectedId(item.id); if (item.kind !== 'root') openDialog({ kind: 'share', item }); },
  };
  const selectedItem = items.find((i) => i.id === selectedId) ?? null;
  const startUpload = () => fileInput.current?.click();
  const newFolder = () => { if (canAdd) openDialog({ kind: 'newFolder' }); };
  const enqueue = (files: File[]) => { if (canAdd && files.length) queue.enqueue(files, folderId); };

  const onSort = (key: SortKey) => setSort((s) => {
    const next: Sort = s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' };
    writePref(SORT_KEY, next);
    return next;
  });

  // ---- keyboard -------------------------------------------------------------------------------
  function gridColumns(): number {
    const els = viewRef.current?.querySelectorAll<HTMLElement>('[data-item-id]');
    if (!els || els.length === 0) return 1;
    const top = els[0].offsetTop;
    let n = 0;
    for (const el of els) { if (el.offsetTop !== top) break; n++; }
    return Math.max(1, n);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // Ignore keys from portalled menus/dialogs (React bubbles them here) and from controls in rows.
    if (!e.currentTarget.contains(target) || target.closest('button, input, textarea, [role="menu"]')) return;
    if (e.altKey || ((e.ctrlKey || e.metaKey) && e.key !== 'Backspace')) return;
    const idx = items.findIndex((i) => i.id === selectedId);
    const sel = idx >= 0 ? items[idx] : null;
    const cols = view === 'grid' ? gridColumns() : 1;
    const go = (i: number) => { if (items.length) focusItem(items[Math.min(items.length - 1, Math.max(0, i))].id); };
    switch (e.key) {
      case 'ArrowDown': go(idx < 0 ? 0 : idx + cols); break;
      case 'ArrowUp': go(idx < 0 ? 0 : idx - cols); break;
      case 'ArrowRight': if (view !== 'grid') return; go(idx + 1); break;
      case 'ArrowLeft': if (view !== 'grid') return; go(idx < 0 ? 0 : idx - 1); break;
      case 'Home': go(0); break;
      case 'End': go(items.length - 1); break;
      case 'Enter': if (!sel) return; open(sel); break;
      case ' ': if (sel?.type !== 'file') return; preview(sel); break;
      case 'F2': if (!sel) return; actions.rename(sel); break;
      case 'Delete': case 'Backspace': if (!sel) return; actions.remove(sel); break;
      case 'Escape': if (!sel) return; setSelectedId(null); break;
      default: return;
    }
    e.preventDefault();
  }

  function onBackgroundClick(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest('[data-item-id], button, [role="menu"]')) setSelectedId(null);
  }
  function onContextMenu(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]');
    const item = el ? items.find((i) => i.id === el.dataset.itemId) ?? null : null;
    setMenuItem(item);
    if (item) setSelectedId(item.id);
  }

  // ---- topbar ---------------------------------------------------------------------------------
  useTopbar(
    <>
      <div className="min-w-0 flex-1">
        <Breadcrumbs chain={ancestors.data ?? (ancestors.isError ? [] : undefined)} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {selectedItem && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => actions.share(selectedItem)}
                aria-label={t('shares.shareItem', { name: selectedItem.name })}
                className="text-muted-foreground hover:text-foreground"
              >
                <Share2 /><span className="max-lg:hidden">{t('shares.share')}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('shares.shareItem', { name: selectedItem.name })}</TooltipContent>
          </Tooltip>
        )}
        <ToggleGroup
          type="single"
          size="sm"
          spacing={0}
          value={view}
          aria-label={t('files.view')}
          onValueChange={(v) => { if (v === 'list' || v === 'grid') setView(v); }}
          className="mr-1 max-sm:hidden"
        >
          {([['list', List, 'files.viewList'], ['grid', LayoutGrid, 'files.viewGrid']] as const).map(([v, Icon, label]) => (
            <Tooltip key={v}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={v} aria-label={t(label)} className="text-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground">
                  <Icon />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{t(label)}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!canAdd} aria-label={t('files.newMenu')}>
              <Plus /><span className="max-sm:hidden">{t('files.newMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={newFolder}><FolderPlus />{t('files.newFolder')}</DropdownMenuItem>
            {/* The view toggle has no room in the topbar on phones. */}
            <DropdownMenuItem className="sm:hidden" onSelect={() => setView(view === 'list' ? 'grid' : 'list')}>
              {view === 'list' ? <LayoutGrid /> : <List />}
              {view === 'list' ? t('files.viewGrid') : t('files.viewList')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" onClick={startUpload} disabled={!canAdd} aria-label={t('files.upload')}>
          <Upload /><span className="max-sm:hidden">{t('files.upload')}</span>
        </Button>
      </div>
    </>,
  );

  // ---- body -----------------------------------------------------------------------------------
  const err = folderQ.error;
  let body;
  if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
    body = <NotFoundMessage />;
  } else if (!folderQ.data && err) {
    body = (
      <StatusMessage title={t('files.loadError.title')} body={t(errorKey(err))}>
        <Button variant="outline" onClick={() => void folderQ.refetch()} disabled={folderQ.isFetching}>{t('files.loadError.retry')}</Button>
      </StatusMessage>
    );
  } else if (!folderQ.data) {
    body = <SkeletonRows view={view} />;
  } else if (items.length === 0) {
    body = <EmptyState isRoot={folder?.kind === 'root'} canAdd={canAdd} onUpload={startUpload} onNewFolder={newFolder} />;
  } else {
    const folders = items.filter((i) => i.type === 'folder').length;
    const files = items.length - folders;
    const viewProps = { items, label: t('files.listLabel', { name: folderName }), selectedId, onSelect: setSelectedId, onOpen: activate, actions };
    body = (
      <ContextMenu modal={false} onOpenChange={(o) => { if (!o) setMenuItem(null); }}>
        <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
          <div className="flex flex-1 flex-col pb-28">
            {view === 'list' ? <FileList {...viewProps} sort={sort} onSort={onSort} /> : <FileGrid {...viewProps} />}
            <p className="px-4 pt-4 text-xs text-muted-foreground tabular-nums md:px-6">
              {[folders > 0 && t('files.folderCount', { count: folders }), files > 0 && t('files.fileCount', { count: files })].filter(Boolean).join(', ')}
            </p>
          </div>
        </ContextMenuTrigger>
        <BrowserContextMenu item={menuItem} actions={actions} onNewFolder={newFolder} onUpload={startUpload} canAdd={canAdd} />
      </ContextMenu>
    );
  }

  const d = dialog;
  return (
    <div className="flex min-h-full flex-col">
      <h1 className="sr-only">{folderName}</h1>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => { enqueue(Array.from(e.target.files ?? [])); e.target.value = ''; }}
      />
      <div ref={viewRef} className="flex flex-1 flex-col" onKeyDown={onKeyDown} onClick={onBackgroundClick}>
        {body}
      </div>
      <DropZone enabled={canAdd} folderName={folderName} onFiles={enqueue} />
      <Suspense fallback={null}>
        {quickLook && (
          <QuickLook
            entries={quickLookFiles}
            activeId={quickLook.id}
            open={quickLook.open}
            onActiveChange={(id) => { setQuickLook({ id, open: true }); setSelectedId(id); }}
            onOpenChange={(o) => { if (!o) setQuickLook((q) => (q ? { ...q, open: false } : q)); }}
            onClosed={(id) => { setQuickLook(null); focusItem(id); }}
            resolveSource={syncPreviewSource}
            onDownload={download}
            onShare={actions.share}
          />
        )}
        {d?.kind === 'newFolder' && (
          <NewFolderDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            folderName={folderName}
            onCreate={async (name) => {
              const created = await mutations.createFolder.mutateAsync({ parentId: folderId, name });
              patchItems((list) => [...list.filter((i) => i.id !== created.id), created]);
              setSelectedId(created.id);
              return created;
            }}
          />
        )}
        {d?.kind === 'rename' && (
          <RenameDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            item={d.item}
            onRename={async (name) => {
              const updated = await mutations.rename.mutateAsync({ item: d.item, name });
              patchItems((list) => list.map((i) => (i.id === updated.id ? updated : i)));
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
            expandedIds={(ancestors.data ?? []).map((a) => a.id)}
            onMove={async (target) => {
              const next = neighborOf(d.item);
              await mutations.move.mutateAsync({ item: d.item, targetId: target.id });
              patchItems((list) => list.filter((i) => i.id !== d.item.id));
              setSelectedId(next);
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
              patchItems((list) => list.filter((i) => i.id !== d.item.id));
              setSelectedId(next);
              notify.success(t('files.toast.deleted', { name: d.item.name }));
            }}
          />
        )}
        {d?.kind === 'share' && (
          <ShareDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            // Opened from QuickLook: focus goes back to QuickLook, so ←/→ and Space keep working.
            onClosed={quickLook?.open
              ? () => document.querySelector<HTMLElement>('[data-slot="quicklook"]')?.focus({ preventScroll: true })
              : restoreFocus}
            item={d.item}
          />
        )}
      </Suspense>
    </div>
  );
}
