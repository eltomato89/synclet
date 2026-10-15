import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

/**
 * Confirmation for an async action: stays open (and shows the error inline) until the action
 * succeeds. Destructive actions keep the focus on "Cancel" so Enter never deletes by accident.
 */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, pendingLabel, destructive, onConfirm, errorMessage }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  body: string;
  confirmLabel: string;
  pendingLabel: string;
  destructive?: boolean;
  onConfirm(): Promise<unknown>;
  /** Message for a failed action. */
  errorMessage(err: unknown): string;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!pending) { onOpenChange(o); if (!o) setError(null); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg font-semibold break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <FormError>{error}</FormError>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('common.cancel')}</AlertDialogCancel>
          {/* A plain button: AlertDialogAction would close before the request finishes. */}
          <Button variant={destructive ? 'destructive' : 'default'} onClick={() => void confirm()} disabled={pending}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
