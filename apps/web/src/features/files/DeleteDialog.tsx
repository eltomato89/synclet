import type { SyncItem } from '@synclet/shared';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { errorKey } from './errors';

export function DeleteDialog({ open, onOpenChange, items, onDelete, onClosed }: {
  open: boolean; onOpenChange(open: boolean): void; items: SyncItem[]; onDelete(): Promise<unknown>; onClosed?(): void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const one = items.length === 1 ? items[0] : null;

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onDelete();
      onOpenChange(false);
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <AlertDialogContent
        // Items go to the trash (recoverable), so Del → Enter confirms, like the desktop.
        onOpenAutoFocus={(e) => { e.preventDefault(); confirmButton.current?.focus(); }}
        onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed(); } }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-semibold break-all">
            {one ? t('files.deleteDialog.title', { name: one.name }) : t('files.deleteDialog.titleMany', { count: items.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {!one ? t('files.deleteDialog.manyBody') : one.type === 'folder' ? t('files.deleteDialog.folderBody') : t('files.deleteDialog.fileBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError>{error}</FormError>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('common.cancel')}</AlertDialogCancel>
          {/* A plain button: AlertDialogAction would close before the request finishes. */}
          <Button variant="destructive" onClick={() => void confirm()} disabled={pending} ref={confirmButton}>
            {pending ? t('files.deleteDialog.submitting') : t('files.deleteDialog.submit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
