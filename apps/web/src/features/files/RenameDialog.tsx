import type { SyncItem } from '@synclet/shared';
import { useTranslation } from 'react-i18next';
import { NameDialog } from './NameDialog';
import { baseNameLength } from './names';

export function RenameDialog({ open, onOpenChange, item, onRename, onClosed }: {
  open: boolean; onOpenChange(open: boolean): void; item: SyncItem; onRename(name: string): Promise<SyncItem>; onClosed?(): void;
}) {
  const { t } = useTranslation();
  return (
    <NameDialog
      open={open}
      onClosed={onClosed}
      onOpenChange={onOpenChange}
      title={t('files.renameDialog.title')}
      label={t('files.renameDialog.label')}
      initial={item.name}
      selectLength={baseNameLength(item.name, item.type === 'folder')}
      submitLabel={t('files.renameDialog.submit')}
      submittingLabel={t('files.renameDialog.submitting')}
      onSubmit={onRename}
    />
  );
}
