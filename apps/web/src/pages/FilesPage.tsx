import type { OfficeNewFormat, SyncAccount, SyncItem } from '@synclet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPaste, FilePlus, FileSpreadsheet, FileText, FolderPlus, FolderUp, LayoutGrid, List, Plus, Presentation, Share2, Upload } from 'lucide-react';
import { type KeyboardEvent, lazy, type MouseEvent, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { useTopbar } from '@/components/app-shell/Topbar';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Breadcrumbs } from '@/features/files/Breadcrumbs';
import { type BulkActions, bulkCaps, downloadZip, shortcut } from '@/features/files/bulk';
import { useClipboard } from '@/features/files/clipboard';
import { useItemDnd } from '@/features/files/dnd';
import { DropZone } from '@/features/files/DropZone';
import { EmptyState, SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { errorKey } from '@/features/files/errors';
import { BrowserContextMenu, canShare, type ItemActions } from '@/features/files/FileActions';
import { FileGrid } from '@/features/files/FileGrid';
import { FileList, type MultiSelect } from '@/features/files/FileList';
import { FolderConflictDialog } from '@/features/files/FolderConflictDialog';
import { pickedFromInputFiles } from '@/features/files/folderUpload';
import {
  folderPath, ROOT_ID, type SortDir, type SortKey, sortItems, useAncestors, useFileMutations, useFolder,
} from '@/features/files/queries';
import { useRevealParam } from '@/features/files/reveal';
import { SelectionBar } from '@/features/files/SelectionBar';
import { type SelectionAction, useSelection } from '@/features/files/selection';
import { UploadPanel } from '@/features/files/UploadPanel';
import { getUploadQueue, type UploadQueue } from '@/features/files/uploads';
import { useFolderUpload } from '@/features/files/useFolderUpload';
import { MORE_FORMATS, openOfficeTab, PRIMARY_FORMATS, reserveOfficeTab } from '@/features/office/office';
import { useCapabilities, useCreateOfficeFile } from '@/features/office/queries';
import { useOperations } from '@/features/operations/OperationsProvider';
import { quickLookEntries } from '@/features/preview/navigation';
import { isPreviewable, syncPreviewSource } from '@/features/preview/source';
import { ReadOnlyBanner } from '@/features/spaces/ReadOnlyBanner';
import { markSpaceUnavailable, PERSONAL, spaceIdOfRoot, spaceOfItem } from '@/features/spaces/useSpaces';
import { ApiError, api } from '@/lib/api';

const NewFolderDialog = lazy(() => import('@/features/files/NewFolderDialog').then((m) => ({ default: m.NewFolderDialog })));
const RenameDialog = lazy(() => import('@/features/files/RenameDialog').then((m) => ({ default: m.RenameDialog })));
const MoveDialog = lazy(() => import('@/features/files/MoveDialog').then((m) => ({ default: m.MoveDialog })));
const DeleteDialog = lazy(() => import('@/features/files/DeleteDialog').then((m) => ({ default: m.DeleteDialog })));
const QuickLook = lazy(() => import('@/features/preview/QuickLook').then((m) => ({ default: m.QuickLook })));
const NewOfficeDialog = lazy(() => import('@/features/office/NewOfficeDialog').then((m) => ({ default: m.NewOfficeDialog })));
const VersionsPanel = lazy(() => import('@/features/versions/VersionsPanel').then((m) => ({ default: m.VersionsPanel })));
const ShareDialog = lazy(() => import('@/features/shares/ShareDialog').then((m) => ({ default: m.ShareDialog })));

/** `root` (My files), a folder `d_<uuid>`, or the root of another space `r_<uuid>`. */
const FOLDER_ID = /^(root|[dr]_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
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

type DialogState = { kind: 'newFolder' } | { kind: 'newOffice'; format: OfficeNewFormat }
  | { kind: 'rename' | 'move' | 'delete' | 'share' | 'versions'; item: SyncItem }
  | { kind: 'moveMany' | 'deleteMany'; items: SyncItem[] };

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
        void qc.invalidateQueries({ queryKey: ['recent'] });
        void qc.invalidateQueries({ queryKey: ['search'] });
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
  const createOffice = useCreateOfficeFile();
  const capabilities = useCapabilities();
  const ops = useOperations();
  const clipboard = useClipboard();
  const officeEnabled = capabilities.office.enabled;

  const [view, setViewState] = useState<View>(() => readPref(VIEW_KEY, 'list', (v) => v === 'list' || v === 'grid'));
  const [sort, setSort] = useState<Sort>(() => readPref(SORT_KEY, { key: 'name', dir: 'asc' }, isSort));
  const [dialog, setDialog] = useState<(DialogState & { open: boolean; n: number }) | null>(null);
  const [menuItem, setMenuItem] = useState<SyncItem | null>(null);
  const [quickLook, setQuickLook] = useState<{ id: string; open: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const focusAfterRender = useRef<string | null>(null);

  const folder = folderQ.data?.folder;
  const folderName = !folder ? '' : folder.kind === 'root' && spaceOfItem(folder) === PERSONAL ? t('shell.myFiles') : folder.name;
  const canAdd = !!folder?.capabilities.addChildren;
  /** Loaded and read-only: write actions are hidden (while loading they only show disabled). */
  const readOnly = !!folder && !canAdd;
  const items = useMemo(
    () => (folderQ.data ? sortItems(folderQ.data.items, sort.key, sort.dir, i18n.language) : []),
    [folderQ.data, sort, i18n.language],
  );
  const order = useMemo(() => items.map((i) => i.id), [items]);
  const sel = useSelection(order);
  // Checkbox selection mode (touch taps toggle): started by a checkbox, ended when the selection is
  // replaced (plain click, `only`, clear) or becomes empty.
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (sel.count === 0) setChecking(false); }, [sel.count]);
  const dispatch = useCallback((a: SelectionAction) => {
    if (a.type === 'only' || a.type === 'clear' || (a.type === 'click' && !a.toggle)) setChecking(false);
    sel.dispatch(a);
  }, [sel.dispatch]);
  const focusId = sel.state.focus;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const selectedItems = useMemo(() => items.filter((i) => sel.state.selected.has(i.id)), [items, sel.state.selected]);
  /** Selects just `item` unless it is part of the selection already (menus, right-click). */
  const select = (item: SyncItem) => { if (!sel.isSelected(item.id)) dispatch({ type: 'only', id: item.id }); };

  useEffect(() => {
    if (!folderName) return;
    const prev = document.title;
    document.title = `${folderName} – Synclet`;
    return () => { document.title = prev; };
  }, [folderName]);

  // A space whose storage is missing answers 503: the sidebar marks it until it loads again.
  const loadError = folderQ.error;
  useEffect(() => {
    // The error first: a refetch of a cached folder can fail while its old data is still there.
    if (loadError instanceof ApiError && loadError.code === 'space_unavailable') {
      const space = spaceIdOfRoot(folderId) ?? (folder && spaceOfItem(folder)) ?? qc.getQueryData<SyncItem>(['item', folderId])?.spaceId;
      if (space) markSpaceUnavailable(qc, space, true);
    } else if (folder) markSpaceUnavailable(qc, spaceOfItem(folder), false);
  }, [folder, loadError, folderId, qc]);

  const setView = (v: View) => { setViewState(v); writePref(VIEW_KEY, v); };

  // ---- focus & selection: one focused row/card (roving tabindex), any number selected ----------
  const itemEl = (id: string) => viewRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
  /** Moves DOM focus to an item (later, when it is not rendered yet). */
  const focusEl = useCallback((id: string) => {
    const el = itemEl(id);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
    else focusAfterRender.current = id;
  }, []);
  /** Selects only `id` and focuses it (created, revealed, after a dialog). */
  const focusItem = useCallback((id: string) => { dispatch({ type: 'only', id }); focusEl(id); }, [dispatch, focusEl]);
  useEffect(() => {
    const id = focusAfterRender.current;
    const el = id ? itemEl(id) : null;
    if (el) { focusAfterRender.current = null; el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  });
  // `?preview=<id>` (search results, recent files): select that item and preview it if possible.
  useRevealParam(folderQ.data ? items : undefined, !folderQ.isFetching, (item) => {
    focusItem(item.id);
    if (isPreviewable(item)) preview(item);
  });
  /** After a dialog closes, focus goes back to the focused item (the selection stays) so the keyboard keeps working. */
  const restoreFocus = () => {
    const f = focusRef.current;
    if (f) focusEl(f);
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
    dispatch({ type: 'focus', id: item.id }); // QuickLook leaves the selection alone
    setQuickLook({ id: item.id, open: true });
  };
  /** Double-click / tap: folders open, previewable files show QuickLook, anything else downloads. */
  const activate = (item: SyncItem) => { if (isPreviewable(item)) preview(item); else open(item); };
  const quickLookFiles = useMemo(() => quickLookEntries(items), [items]);
  const actions: ItemActions = {
    open,
    preview,
    rename: (item) => { select(item); if (item.capabilities.rename) openDialog({ kind: 'rename', item }); },
    move: (item) => { select(item); if (item.capabilities.move) openDialog({ kind: 'move', item }); },
    remove: (item) => { select(item); if (item.capabilities.delete) openDialog({ kind: 'delete', item }); },
    share: (item) => { select(item); if (canShare(item)) openDialog({ kind: 'share', item }); },
    openInOffice: officeEnabled ? (item) => openOfficeTab(item.id) : undefined,
    versions: capabilities.versions ? (item) => { select(item); if (item.type === 'file') openDialog({ kind: 'versions', item }); } : undefined,
  };
  const selectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  // Actions on the whole selection; copy, move and delete run as server operations.
  const caps = bulkCaps(selectedItems);
  const bulk: BulkActions = {
    download: () => { downloadZip(selectedItems).catch(() => notify.error(t('files.bulk.zipFailed'))); },
    copy: () => {
      if (!selectedItems.length) return;
      clipboard.copy(selectedItems.map((i) => i.id), folderId);
      notify.success(t('files.bulk.copied', { count: selectedItems.length }));
    },
    move: () => { if (caps.move && selectedItems.length) openDialog({ kind: 'moveMany', items: selectedItems }); },
    remove: () => { if (caps.delete && selectedItems.length) openDialog({ kind: 'deleteMany', items: selectedItems }); },
  };
  const canPaste = canAdd && !!clipboard.content;
  const paste = () => {
    const c = clipboard.content;
    if (!canAdd || !c) return;
    void ops.start({ kind: 'copy', itemIds: c.itemIds, targetId: folderId });
  };
  // Dragging onto a folder or breadcrumb segment moves; ⌥/Ctrl (or items that cannot move) copies.
  const dnd = useItemDnd({
    folderId,
    selectedItems,
    label: (count) => t('files.dnd.count', { count }),
    onDrop: (targetId, ids, copy) => {
      void ops.start({ kind: copy ? 'copy' : 'move', itemIds: ids, targetId });
      if (!copy) dispatch({ type: 'clear' });
    },
  });
  const startUpload = () => fileInput.current?.click();
  const startFolderUpload = () => folderInput.current?.click();
  const newFolder = () => { if (canAdd) openDialog({ kind: 'newFolder' }); };
  const newOffice = (format: OfficeNewFormat) => { if (canAdd) openDialog({ kind: 'newOffice', format }); };
  const enqueue = (files: File[]) => { if (canAdd && files.length) queue.enqueue(files, folderId); };
  const folderUpload = useFolderUpload({
    queue,
    folderId,
    siblings: folderQ.data?.items ?? [],
    onFoldersChanged: () => {
      void qc.invalidateQueries({ queryKey: ['folder', folderId] });
      void qc.invalidateQueries({ queryKey: ['subfolders', folderId] });
    },
  });
  const uploadPicked: typeof folderUpload.upload = async (picked) => { if (canAdd) await folderUpload.upload(picked); };

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
    if (!e.currentTarget.contains(target) || target.closest('button:not([data-slot="checkbox"]), input, textarea, [role="menu"]')) return;
    if (e.altKey) return;
    // A checkbox handles Space/Enter itself (it should not have focus, but never act twice).
    if ((e.key === ' ' || e.key === 'Enter') && target.closest('[data-slot="checkbox"]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const idx = items.findIndex((i) => i.id === focusId);
    const cur = idx >= 0 ? items[idx] : null;
    const cols = view === 'grid' ? gridColumns() : 1;
    /** Arrows: plain moves the selection, Shift extends it, ⌘/Ctrl moves only the focus. */
    const nav = (i: number) => {
      if (!items.length) return;
      const id = items[Math.min(items.length - 1, Math.max(0, i))].id;
      dispatch({ type: 'move', to: id, extend: e.shiftKey, focusOnly: mod && !e.shiftKey });
      focusEl(id);
    };
    switch (e.key) {
      case 'ArrowDown': nav(idx < 0 ? 0 : idx + cols); break;
      case 'ArrowUp': nav(idx < 0 ? 0 : idx - cols); break;
      case 'ArrowRight': if (view !== 'grid') return; nav(idx + 1); break;
      case 'ArrowLeft': if (view !== 'grid') return; nav(idx < 0 ? 0 : idx - 1); break;
      case 'Home': nav(0); break;
      case 'End': nav(items.length - 1); break;
      case 'a': case 'A': if (!mod) return; dispatch({ type: 'all' }); break;
      case 'c': case 'C': if (!mod) return; bulk.copy(); break;
      case 'v': case 'V': if (!mod) return; paste(); break;
      case 'Enter': if (!cur || mod) return; open(cur); break;
      case ' ':
        if (mod) { dispatch({ type: 'toggleFocus' }); break; }
        if (cur?.type !== 'file') return;
        preview(cur);
        break;
      case 'F2': if (!cur || mod) return; actions.rename(cur); break;
      case 'Delete': case 'Backspace': {
        // Acts on the selection only: none selected, nothing to delete.
        if (selectedItems.length >= 2) { bulk.remove(); break; }
        const one = selectedItems.length === 1 ? selectedItems[0] : null;
        if (!one) return;
        actions.remove(one);
        break;
      }
      case 'Escape': if (sel.count === 0) return; dispatch({ type: 'clear' }); break;
      default: return;
    }
    e.preventDefault();
  }

  // ⌘A / ⌘V also when nothing in the listing has focus (the body after opening a folder, an empty
  // folder). Keys the listing handled itself (default prevented, or from inside it) are left alone,
  // as are fields, open dialogs and menus.
  const pageKeys = useRef({ selectAll: () => {}, paste });
  pageKeys.current = { selectAll: () => { if (items.length) dispatch({ type: 'all' }); }, paste };
  useEffect(() => {
    const onDocKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'a' && key !== 'v') return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && (viewRef.current?.contains(target) || target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], [role="alertdialog"], [role="menu"]'))) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      e.preventDefault();
      if (key === 'a') pageKeys.current.selectAll();
      else pageKeys.current.paste();
    };
    document.addEventListener('keydown', onDocKeyDown);
    return () => document.removeEventListener('keydown', onDocKeyDown);
  }, []);

  function onBackgroundClick(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest('[data-item-id], button, [role="menu"]')) dispatch({ type: 'clear' });
  }
  function onContextMenu(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-item-id]');
    const item = el ? items.find((i) => i.id === el.dataset.itemId) ?? null : null;
    setMenuItem(item);
    if (item) select(item);
  }

  // ---- topbar ---------------------------------------------------------------------------------
  // The breadcrumbs always stay (they take drops); with two or more selected the selection bar replaces the actions.
  useTopbar(
    <>
      <div className="min-w-0 flex-1">
        <Breadcrumbs chain={ancestors.data ?? (ancestors.isError ? [] : undefined)} dropTarget={(item) => dnd.target(item)} />
      </div>
      {sel.count >= 2 ? (
        <SelectionBar count={sel.count} caps={caps} actions={bulk} onClear={() => dispatch({ type: 'clear' })} />
      ) : <div className="flex shrink-0 items-center gap-1.5">
        {selectedItem && canShare(selectedItem) && (
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
        {readOnly && (
          // The view toggle lives in the "New" menu on phones; read-only folders have no such menu.
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground sm:hidden" aria-label={view === 'list' ? t('files.viewGrid') : t('files.viewList')} onClick={() => setView(view === 'list' ? 'grid' : 'list')}>
            {view === 'list' ? <LayoutGrid /> : <List />}
          </Button>
        )}
        {!readOnly && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={!canAdd} aria-label={t('files.newMenu')}>
              <Plus /><span className="max-sm:hidden">{t('files.newMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={newFolder}><FolderPlus />{t('files.newFolder')}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canPaste} onSelect={paste}>
              <ClipboardPaste />{t('files.bulk.paste')}<DropdownMenuShortcut>{shortcut(t, 'V')}</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {PRIMARY_FORMATS.map((f) => {
              const Icon = { docx: FileText, xlsx: FileSpreadsheet, pptx: Presentation }[f];
              return <DropdownMenuItem key={f} onSelect={() => newOffice(f)}><Icon />{t(`office.new.${f}.menu`)}</DropdownMenuItem>;
            })}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><FilePlus />{t('office.new.more')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {MORE_FORMATS.map((f) => (
                  <DropdownMenuItem key={f} onSelect={() => newOffice(f)}>
                    {t(`office.new.${f}.menu`)}<DropdownMenuShortcut>.{f}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* The view toggle has no room in the topbar on phones. */}
            <DropdownMenuItem className="sm:hidden" onSelect={() => setView(view === 'list' ? 'grid' : 'list')}>
              {view === 'list' ? <LayoutGrid /> : <List />}
              {view === 'list' ? t('files.viewGrid') : t('files.viewList')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
        {!readOnly && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" disabled={!canAdd} aria-label={t('files.upload')}>
              <Upload /><span className="max-sm:hidden">{t('files.upload')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={startUpload}><Upload />{t('files.uploadFiles')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={startFolderUpload}><FolderUp />{t('files.uploadFolder')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>}
    </>,
  );

  // ---- body -----------------------------------------------------------------------------------
  const err = folderQ.error;
  let body;
  if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
    body = <NotFoundMessage />;
  } else if (err instanceof ApiError && err.code === 'space_unavailable') {
    body = (
      <StatusMessage title={t('spaces.unavailableTitle')} body={t('spaces.unavailableBody')}>
        <Button variant="outline" onClick={() => void folderQ.refetch()} disabled={folderQ.isFetching}>{t('files.loadError.retry')}</Button>
      </StatusMessage>
    );
  } else if (!folderQ.data && err) {
    body = (
      <StatusMessage title={t('files.loadError.title')} body={t(errorKey(err))}>
        <Button variant="outline" onClick={() => void folderQ.refetch()} disabled={folderQ.isFetching}>{t('files.loadError.retry')}</Button>
      </StatusMessage>
    );
  } else if (!folderQ.data) {
    body = <SkeletonRows view={view} />;
  } else if (items.length === 0) {
    body = <EmptyState isRoot={folder?.kind === 'root'} canAdd={canAdd} onUpload={startUpload} onUploadFolder={startFolderUpload} onNewFolder={newFolder} />;
  } else {
    const folders = items.filter((i) => i.type === 'folder').length;
    const files = items.length - folders;
    const multi: MultiSelect = {
      isSelected: sel.isSelected, count: sel.count, selecting: checking && sel.count > 0, total: items.length,
      onClick: (item, m) => dispatch({ type: 'click', id: item.id, toggle: m.toggle, range: m.range }),
      onCheck: (item, range) => { dispatch({ type: 'click', id: item.id, toggle: true, range }); setChecking(true); },
      onCheckAll: () => {
        if (sel.count === items.length) dispatch({ type: 'clear' });
        else { dispatch({ type: 'all' }); setChecking(true); }
      },
    };
    const viewProps = {
      items, label: t('files.listLabel', { name: folderName }), selectedId: focusId,
      onSelect: (id: string) => dispatch({ type: 'focus', id }), onOpen: activate, actions, multi, dnd,
    };
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
        <BrowserContextMenu
          item={menuItem} actions={actions} onNewFolder={newFolder} onUpload={startUpload} onUploadFolder={startFolderUpload} canAdd={canAdd}
          bulk={{ count: sel.count, caps, actions: bulk }} paste={{ enabled: canPaste, onPaste: paste }}
        />
      </ContextMenu>
    );
  }

  const d = dialog;
  return (
    <div className="flex min-h-full flex-col">
      <h1 className="sr-only">{folderName}</h1>
      <p className="sr-only" aria-live="polite">{sel.count > 0 ? t('files.selection.count', { count: sel.count }) : ''}</p>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        data-upload="files"
        onChange={(e) => { enqueue(Array.from(e.target.files ?? [])); e.target.value = ''; }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        tabIndex={-1}
        data-upload="folder"
        // Not in React's types; the browser then picks a whole folder (files carry webkitRelativePath).
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          // The picker never lists folders, only files: an empty selection was an empty folder.
          if (files.length) void uploadPicked(pickedFromInputFiles(files));
          else toast.info(t('files.folderUpload.emptyFolder'), { position: 'bottom-center' });
        }}
      />
      <FolderConflictDialog question={folderUpload.question} onAnswer={folderUpload.answer} />
      {readOnly && <ReadOnlyBanner />}
      <div ref={viewRef} className="flex flex-1 flex-col" onKeyDown={onKeyDown} onClick={onBackgroundClick}>
        {body}
      </div>
      <DropZone enabled={canAdd} folderName={folderName} onPicked={(p) => void uploadPicked(p)} />
      <Suspense fallback={null}>
        {quickLook && (
          <QuickLook
            entries={quickLookFiles}
            activeId={quickLook.id}
            open={quickLook.open}
            onActiveChange={(id) => { setQuickLook({ id, open: true }); dispatch({ type: 'only', id }); }}
            onOpenChange={(o) => { if (!o) setQuickLook((q) => (q ? { ...q, open: false } : q)); }}
            onClosed={(id) => { setQuickLook(null); focusEl(id); }}
            resolveSource={syncPreviewSource}
            onDownload={download}
            onShare={actions.share}
            onOpenInOffice={actions.openInOffice}
            onVersions={actions.versions}
            writable={(e: SyncItem) => e.capabilities.write !== false}
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
              focusItem(created.id);
              return created;
            }}
          />
        )}
        {d?.kind === 'newOffice' && (
          <NewOfficeDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            format={d.format}
            folderName={folderName}
            opensEditor={officeEnabled}
            onCreate={async (name) => {
              // Opened inside the submit click so popup blockers allow it; pointed at the editor once the file exists.
              const tab = officeEnabled ? reserveOfficeTab() : null;
              try {
                const created = await createOffice.mutateAsync({ parentId: folderId, name, format: d.format });
                patchItems((list) => [...list.filter((i) => i.id !== created.id), created]);
                focusItem(created.id);
                tab?.go(created.id);
                return created;
              } catch (err) {
                tab?.cancel();
                throw err;
              }
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
            items={[d.item]}
            expandedIds={(ancestors.data ?? []).map((a) => a.id)}
            onMove={async (target) => {
              const next = neighborOf(d.item);
              await mutations.move.mutateAsync({ item: d.item, targetId: target.id });
              patchItems((list) => list.filter((i) => i.id !== d.item.id));
              if (next) focusItem(next); else dispatch({ type: 'clear' });
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
            items={[d.item]}
            onDelete={async () => {
              const next = neighborOf(d.item);
              await mutations.remove.mutateAsync(d.item);
              patchItems((list) => list.filter((i) => i.id !== d.item.id));
              if (next) focusItem(next); else dispatch({ type: 'clear' });
              notify.success(t('files.toast.deleted', { name: d.item.name }));
            }}
          />
        )}
        {d?.kind === 'deleteMany' && (
          <DeleteDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            items={d.items}
            onDelete={async () => {
              await ops.start({ kind: 'delete', itemIds: d.items.map((i) => i.id) }, { throwOnError: true });
              const gone = new Set(d.items.map((i) => i.id));
              patchItems((list) => list.filter((i) => !gone.has(i.id))); // the refresh after the operation confirms
              dispatch({ type: 'clear' });
            }}
          />
        )}
        {d?.kind === 'moveMany' && (
          <MoveDialog
            key={d.n}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={restoreFocus}
            items={d.items}
            expandedIds={(ancestors.data ?? []).map((a) => a.id)}
            onMove={async (target) => {
              await ops.start({ kind: 'move', itemIds: d.items.map((i) => i.id), targetId: target.id }, { throwOnError: true });
              dispatch({ type: 'clear' });
            }}
          />
        )}
        {d?.kind === 'versions' && (
          <VersionsPanel
            key={d.n}
            item={d.item}
            open={d.open}
            onOpenChange={onDialogOpenChange}
            onClosed={quickLook?.open
              ? () => document.querySelector<HTMLElement>('[data-slot="quicklook"]')?.focus({ preventScroll: true })
              : restoreFocus}
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
