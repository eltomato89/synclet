import type { SyncItem } from '@synclet/shared';
import { ClipboardPaste, Copy, Download, Eye, FilePen, FolderInput, FolderOpen, FolderPlus, FolderUp, History, Lock, MoreHorizontal, PencilLine, Share2, Trash2, Upload } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut,
} from '@/components/ui/context-menu';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isOfficeFile } from '@/features/office/office';
import { cn } from '@/lib/utils';
import { type BulkActions, type BulkCaps, shortcut } from './bulk';

export interface ItemActions {
  open(item: SyncItem): void;
  /** QuickLook; offered for files only. */
  preview?(item: SyncItem): void;
  rename(item: SyncItem): void;
  move(item: SyncItem): void;
  remove(item: SyncItem): void;
  share(item: SyncItem): void;
  /** Opens an office file in the editor; set only when office editing is available. */
  openInOffice?(item: SyncItem): void;
  /** Opens the versions panel; set only when the server has versions enabled. */
  versions?(item: SyncItem): void;
}

/** Whether the menus offer "Versions" for this item. */
export function canShowVersions(item: Pick<SyncItem, 'type'>, actions: Pick<ItemActions, 'versions'>): boolean {
  return !!actions.versions && item.type === 'file';
}

/** Whether the menus offer "Open in Office" for this item. */
export function canOpenInOffice(item: Pick<SyncItem, 'type' | 'name'>, actions: Pick<ItemActions, 'openInOffice'>): boolean {
  return !!actions.openInOffice && item.type === 'file' && isOfficeFile(item.name);
}

/** Share links need write access to the item's space; a space root can't be shared. */
export function canShare(item: Pick<SyncItem, 'kind' | 'capabilities'>): boolean {
  return item.kind !== 'root' && item.capabilities.write !== false;
}

interface MenuParts {
  Item: ComponentType<{ onSelect?: () => void; variant?: 'default' | 'destructive'; disabled?: boolean; children: ReactNode }>;
  Separator: ComponentType;
  Shortcut: ComponentType<{ children: ReactNode }>;
}
const DROPDOWN: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Shortcut: DropdownMenuShortcut };
const CONTEXT: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator, Shortcut: ContextMenuShortcut };

function ItemMenuItems({ item, actions, parts: { Item, Separator, Shortcut } }: { item: SyncItem; actions: ItemActions; parts: MenuParts }) {
  const { t } = useTranslation();
  const caps = item.capabilities;
  return (
    <>
      <Item onSelect={() => actions.open(item)}>
        {item.type === 'folder' ? <FolderOpen /> : <Download />}
        {item.type === 'folder' ? t('files.open') : t('common.download')}
        <Shortcut>↵</Shortcut>
      </Item>
      {canOpenInOffice(item, actions) && (
        <Item onSelect={() => actions.openInOffice?.(item)}>
          <FilePen />{item.capabilities.write === false ? t('office.view') : t('office.open')}
        </Item>
      )}
      {actions.preview && item.type === 'file' && (
        <Item onSelect={() => actions.preview?.(item)}>
          <Eye />{t('files.preview')}<Shortcut>{t('files.shortcutPreview')}</Shortcut>
        </Item>
      )}
      {canShowVersions(item, actions) && (
        <Item onSelect={() => actions.versions?.(item)}>
          <History />{t('files.versions')}
        </Item>
      )}
      {canShare(item) && (
        <Item onSelect={() => actions.share(item)}>
          <Share2 />{t('shares.action')}
        </Item>
      )}
      {/* Write actions are hidden, not disabled, where the item's space is read-only for the user. */}
      {(caps.rename || caps.move) && <Separator />}
      {caps.rename && (
        <Item onSelect={() => actions.rename(item)}>
          <PencilLine />{t('common.rename')}<Shortcut>F2</Shortcut>
        </Item>
      )}
      {caps.move && (
        <Item onSelect={() => actions.move(item)}>
          <FolderInput />{t('common.move')}
        </Item>
      )}
      {caps.delete && <Separator />}
      {caps.delete && (
        <Item variant="destructive" onSelect={() => actions.remove(item)}>
          <Trash2 />{t('common.delete')}<Shortcut>{t('files.shortcutDelete')}</Shortcut>
        </Item>
      )}
    </>
  );
}

/** The "⋯" button that reveals on row hover / selection. */
export function ItemMenuButton({ item, actions, className }: { item: SyncItem; actions: ItemActions; className?: string }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          tabIndex={-1}
          aria-label={t('files.itemActions', { name: item.name })}
          className={cn('text-muted-foreground hover:bg-background hover:text-foreground data-[state=open]:bg-background data-[state=open]:text-foreground data-[state=open]:opacity-100', className)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ItemMenuItems item={item} actions={actions} parts={DROPDOWN} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Content of the right-click menu shared by list and grid: item actions when an item was
 * targeted (the bulk actions when it is part of a selection of two or more), otherwise
 * "new folder" / "upload" / "paste" for the folder itself.
 */
export function BrowserContextMenu({ item, actions, onNewFolder, onUpload, onUploadFolder, canAdd, bulk, paste }: {
  item: SyncItem | null; actions: ItemActions; onNewFolder(): void; onUpload(): void; onUploadFolder(): void; canAdd: boolean;
  bulk?: { count: number; caps: BulkCaps; actions: BulkActions };
  paste?: { enabled: boolean; onPaste(): void };
}) {
  const { t } = useTranslation();
  return (
    <ContextMenuContent className="w-52">
      {item && bulk && bulk.count >= 2 ? (
        <>
          <ContextMenuItem onSelect={bulk.actions.download}><Download />{t('files.bulk.download')}</ContextMenuItem>
          <ContextMenuItem onSelect={bulk.actions.copy}>
            <Copy />{t('files.bulk.copy')}<ContextMenuShortcut>{shortcut(t, 'C')}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!bulk.caps.move} onSelect={bulk.actions.move}><FolderInput />{t('files.bulk.move')}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" disabled={!bulk.caps.delete} onSelect={bulk.actions.remove}>
            <Trash2 />{t('common.delete')}<ContextMenuShortcut>{t('files.shortcutDelete')}</ContextMenuShortcut>
          </ContextMenuItem>
        </>
      ) : item ? (
        <ItemMenuItems item={item} actions={actions} parts={CONTEXT} />
      ) : canAdd ? (
        <>
          <ContextMenuItem onSelect={onNewFolder}><FolderPlus />{t('files.newFolderDialog.title')}</ContextMenuItem>
          <ContextMenuItem onSelect={onUpload}><Upload />{t('files.uploadFiles')}</ContextMenuItem>
          <ContextMenuItem onSelect={onUploadFolder}><FolderUp />{t('files.uploadFolder')}</ContextMenuItem>
          {paste && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={!paste.enabled} onSelect={paste.onPaste}>
                <ClipboardPaste />{t('files.bulk.paste')}<ContextMenuShortcut>{shortcut(t, 'V')}</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
        </>
      ) : (
        <ContextMenuItem disabled><Lock />{t('spaces.readOnlyMenu')}</ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}
