import type { OfficeNewFormat } from '@synclet/shared';
import { useTranslation } from 'react-i18next';
import { NameDialog } from '@/features/files/NameDialog';

/** Name for a new document from a template; the extension is kept (and added if removed). */
export function NewOfficeDialog({ open, onOpenChange, onClosed, format, folderName, opensEditor, onCreate }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onClosed?(): void;
  format: OfficeNewFormat;
  folderName: string;
  /** Office editing is available: the new file opens in a new tab. */
  opensEditor: boolean;
  onCreate(name: string): Promise<unknown>;
}) {
  const { t } = useTranslation();
  const base = t(`office.new.${format}.defaultName`);
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      onClosed={onClosed}
      title={t(`office.new.${format}.title`)}
      description={t(opensEditor ? 'office.new.descriptionOpens' : 'office.new.description', { folder: folderName })}
      label={t('office.new.label')}
      initial={`${base}.${format}`}
      submitInitial
      selectLength={base.length}
      submitLabel={t(opensEditor ? 'office.new.submitOpen' : 'office.new.submit')}
      submittingLabel={t('office.new.submitting')}
      onSubmit={onCreate}
    />
  );
}
