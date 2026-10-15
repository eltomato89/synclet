import type { SyncItem } from '@synclet/shared';
import { useTranslation } from 'react-i18next';
import { NameDialog } from './NameDialog';

export function NewFolderDialog({ open, onOpenChange, folderName, onCreate, onClosed }: {
  open: boolean; onOpenChange(open: boolean): void; folderName: string; onCreate(name: string): Promise<SyncItem>; onClosed?(): void;
}) {
  const { t } = useTranslation();
  return (
    <NameDialog
      open={open}
      onClosed={onClosed}
      onOpenChange={onOpenChange}
      title={t('files.newFolderDialog.title')}
      description={t('files.newFolderDialog.description', { folder: folderName })}
      label={t('files.newFolderDialog.label')}
      placeholder={t('files.newFolderDialog.placeholder')}
      submitLabel={t('files.newFolderDialog.submit')}
      submittingLabel={t('files.newFolderDialog.submitting')}
      onSubmit={onCreate}
    />
  );
}
