import type { SyncItem } from '@synclet/shared';
import { Download, Eye, FilePen, FolderInput, FolderOpen, FolderPlus, FolderUp, History, MoreHorizontal, PencilLine, Share2, Trash2, Upload } from 'lucide-react';
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
          <FilePen />{t('office.open')}
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
      <Item onSelect={() => actions.share(item)} disabled={item.kind === 'root'}>
        <Share2 />{t('shares.action')}
      </Item>
      <Separator />
      <Item onSelect={() => actions.rename(item)} disabled={!caps.rename}>
        <PencilLine />{t('common.rename')}<Shortcut>F2</Shortcut>
      </Item>
      <Item onSelect={() => actions.move(item)} disabled={!caps.move}>
        <FolderInput />{t('common.move')}
      </Item>
      <Separator />
      <Item variant="destructive" onSelect={() => actions.remove(item)} disabled={!caps.delete}>
        <Trash2 />{t('common.delete')}<Shortcut>{t('files.shortcutDelete')}</Shortcut>
      </Item>
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
 * targeted, otherwise "new folder" / "upload" for the folder itself.
 */
export function BrowserContextMenu({ item, actions, onNewFolder, onUpload, onUploadFolder, canAdd }: {
  item: SyncItem | null; actions: ItemActions; onNewFolder(): void; onUpload(): void; onUploadFolder(): void; canAdd: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenuContent className="w-52">
      {item ? (
        <ItemMenuItems item={item} actions={actions} parts={CONTEXT} />
      ) : (
        <>
          <ContextMenuItem onSelect={onNewFolder} disabled={!canAdd}><FolderPlus />{t('files.newFolderDialog.title')}</ContextMenuItem>
          <ContextMenuItem onSelect={onUpload} disabled={!canAdd}><Upload />{t('files.uploadFiles')}</ContextMenuItem>
          <ContextMenuItem onSelect={onUploadFolder} disabled={!canAdd}><FolderUp />{t('files.uploadFolder')}</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
