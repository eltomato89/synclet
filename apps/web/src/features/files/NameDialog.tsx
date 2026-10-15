import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorKey } from './errors';
import { validateName } from './names';

export interface NameDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  initial?: string;
  /** Submit the initial value as is (a suggested name) instead of treating it as "no change". */
  submitInitial?: boolean;
  /** Characters preselected when the dialog opens (base name without extension). */
  selectLength?: number;
  submitLabel: string;
  submittingLabel: string;
  /** Rejects with an ApiError; the code is shown inline (e.g. `name_conflict`). */
  onSubmit(name: string): Promise<unknown>;
  /** Called once the dialog has closed, instead of Radix' focus restoration. */
  onClosed?(): void;
}

/** Single-field name dialog used for "new folder", "new document" and "rename". */
export function NameDialog(p: NameDialogProps) {
  const { t } = useTranslation();
  const initial = p.initial ?? '';
  const [value, setValue] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const name = value.trim().normalize('NFC');
  const nameError = validateName(name);
  // Live feedback for bad characters etc.; "empty" only after a submit attempt.
  const shownNameError = nameError && (submitted || nameError !== 'empty') ? t(`files.nameErrors.${nameError}`) : null;
  const error = shownNameError ?? serverError;
  const unchanged = !p.submitInitial && p.initial !== undefined && name === p.initial;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameError || pending) return;
    if (unchanged) { p.onOpenChange(false); return; }
    setPending(true);
    setServerError(null);
    try {
      await p.onSubmit(name);
      p.onOpenChange(false);
    } catch (err) {
      setServerError(t(errorKey(err)));
      input.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={p.open} onOpenChange={(o) => { if (!pending) p.onOpenChange(o); }}>
      <DialogContent
        className="gap-5"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
          input.current?.setSelectionRange(0, p.selectLength ?? initial.length);
        }}
        onCloseAutoFocus={(e) => { if (p.onClosed) { e.preventDefault(); p.onClosed(); } }}
        {...(p.description ? {} : { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">{p.title}</DialogTitle>
          {p.description && <DialogDescription>{p.description}</DialogDescription>}
        </DialogHeader>
        <form id="name-dialog-form" onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
          <Label htmlFor="name-dialog-input" className="sr-only">{p.label}</Label>
          <Input
            ref={input}
            id="name-dialog-input"
            value={value}
            placeholder={p.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'name-dialog-error' : undefined}
            onChange={(e) => { setValue(e.target.value); setServerError(null); }}
          />
          <div id="name-dialog-error"><FormError>{error}</FormError></div>
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>{t('common.cancel')}</Button>
          </DialogClose>
          <Button type="submit" form="name-dialog-form" disabled={pending || (submitted && !!nameError)}>
            {pending ? p.submittingLabel : p.submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
