import type { ConflictAction, OperationEntryInfo, SyncOperation } from '@synclet/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { errorKey } from '@/features/files/errors';
import { FileIcon } from '@/features/files/FileIcon';
import { formatBytes, formatDate } from '@/lib/format';
import { targetLabel } from './labels';

function Side({ label, name, info }: { label: string; name: string; info: OperationEntryInfo }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="min-w-0 flex-1 rounded-lg border p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <FileIcon item={{ type: info.type, name, mime: null }} className="size-5" />
        <span className="truncate text-sm font-medium" title={name}>{name}</span>
      </div>
      <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground tabular-nums">
        <div>{info.type === 'folder' ? t('operations.conflict.folder') : t('operations.conflict.file')}</div>
        <div>{formatBytes(info.size, i18n.language)}</div>
        <div>{formatDate(info.modifiedAt, i18n.language)}</div>
      </dl>
    </div>
  );
}

/** Asks what to do with a name conflict of a waiting operation (replace / keep both / skip). */
export function ConflictDialog({ op, open, onOpenChange, onResolve, onCancelOperation }: {
  op: SyncOperation; open: boolean; onOpenChange(open: boolean): void;
  onResolve(action: ConflictAction, applyToAll: boolean): Promise<void>; onCancelOperation(): Promise<void>;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = op.conflict;
  if (!c) return null;

  async function run(fn: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-8 text-lg font-semibold break-all">{t('operations.conflict.title', { name: c.name, target: targetLabel(t, op) })}</DialogTitle>
          <DialogDescription>{t('operations.conflict.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-3 max-sm:flex-col">
          <Side label={t('operations.conflict.new')} name={c.name} info={c.source} />
          <Side label={t('operations.conflict.existing')} name={c.name} info={c.existing} />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="conflict-all" checked={all} onCheckedChange={(v) => setAll(v === true)} />
          <Label htmlFor="conflict-all" className="text-sm font-normal">{t('operations.conflict.applyToAll')}</Label>
        </div>
        {c.canReplace && <p className="-mt-2 text-xs text-muted-foreground">{t('operations.conflict.replaceHint')}</p>}
        <FormError>{error}</FormError>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" disabled={pending} onClick={() => void run(onCancelOperation)} className="text-muted-foreground">
            {t('operations.conflict.cancelOperation')}
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => void run(() => onResolve('skip', all))}>{t('operations.conflict.skip')}</Button>
            <Button variant="outline" disabled={pending} onClick={() => void run(() => onResolve('keepBoth', all))}>{t('operations.conflict.keepBoth')}</Button>
            {c.canReplace && <Button disabled={pending} onClick={() => void run(() => onResolve('replace', all))}>{t('operations.conflict.replace')}</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
