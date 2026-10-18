import type { SyncOperation } from '@synclet/shared';
import type { TFunction } from 'i18next';
import { Check, CircleAlert, Copy, FolderInput, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DockPortal } from '@/components/app-shell/PanelDock';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isActive } from './api';
import { ConflictDialog } from './ConflictDialog';
import { operationTitle } from './labels';
import { type TrackedOperation, useOperations } from './OperationsProvider';

const ICON = { copy: Copy, move: FolderInput, delete: Trash2 } as const;
const ITEM_ERRORS = new Set(['not_found', 'forbidden', 'conflict', 'read_error', 'name_conflict']);

function summary(t: TFunction, op: SyncOperation): string {
  if (op.status === 'queued') return t('operations.status.queued');
  if (op.status === 'waiting') return t('operations.status.waiting');
  if (op.status === 'cancelled') return t('operations.status.cancelled');
  if (op.status === 'failed') return t(`operations.failed.${op.error ?? 'internal'}`, { defaultValue: t('operations.failed.internal') });
  const done = op.results.filter((r) => r.outcome === 'done').length;
  const skipped = op.results.filter((r) => r.outcome === 'skipped').length;
  const main = done === op.itemCount ? t(`operations.result.${op.kind}All`, { count: done }) : t(`operations.result.${op.kind}`, { done, count: op.itemCount });
  return skipped > 0 ? `${main}, ${t('operations.result.skipped', { count: skipped })}` : main;
}

function Row({ entry }: { entry: TrackedOperation }) {
  const { t } = useTranslation();
  const ops = useOperations();
  const [showErrors, setShowErrors] = useState(false);
  const { op } = entry;
  const active = isActive(op);
  const failures = op.results.filter((r) => r.outcome === 'failed');
  const progress = op.totalBytes > 0 ? op.doneBytes / op.totalBytes : op.doneItems / Math.max(1, op.totalItems);
  const Icon = ICON[op.kind];
  const bad = op.status === 'failed' || failures.length > 0;

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className={cn('flex size-6 shrink-0 items-center justify-center', bad ? 'text-destructive' : !active && 'text-primary')}>
          {active ? <Icon className="size-4.5 text-muted-foreground" /> : bad ? <CircleAlert className="size-5" /> : <Check className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={operationTitle(t, op)}>{operationTitle(t, op)}</div>
          <div className={cn('text-xs tabular-nums', op.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{active && op.status === 'running' ? null : summary(t, op)}</div>
          {op.status === 'running' && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={operationTitle(t, op)}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full origin-left rounded-full bg-primary transition-transform duration-200" style={{ transform: `scaleX(${progress})` }} />
            </div>
          )}
        </div>
        {op.status === 'waiting' && (
          <Button size="sm" variant="outline" onClick={() => ops.setConflictOpen(op.id, true)}>{t('operations.decide')}</Button>
        )}
        {active ? (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => void ops.cancel(op.id)} aria-label={t('operations.cancel')} title={t('operations.cancel')}>
            <X />
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => ops.dismiss(op.id)} aria-label={t('operations.close')}>
            <X />
          </Button>
        )}
      </div>
      {failures.length > 0 && (
        <div className="mt-1 pl-9">
          <button type="button" className="text-xs font-medium text-destructive underline-offset-2 hover:underline" onClick={() => setShowErrors((s) => !s)}>
            {showErrors ? t('operations.hideErrors') : t('operations.showErrors')}
          </button>
          {showErrors && (
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
              {failures.map((r) => (
                <li key={r.sourceId} className="truncate" title={r.name}>
                  {r.name || r.sourceId} – {t(`operations.itemError.${ITEM_ERRORS.has(r.error ?? '') ? r.error : 'unknown'}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {op.conflict && (
        <ConflictDialog
          op={op}
          open={entry.conflictOpen}
          onOpenChange={(o) => ops.setConflictOpen(op.id, o)}
          onResolve={(action, applyToAll) => ops.resolve(op.id, { action, applyToAll })}
          onCancelOperation={() => ops.cancel(op.id)}
        />
      )}
    </li>
  );
}

/** Bulk operations of this session, above the upload panel in the dock. */
export function OperationsPanel() {
  const { t } = useTranslation();
  const { operations, offline } = useOperations();
  if (operations.length === 0) return null;
  return (
    <DockPortal>
      <section
        aria-label={t('operations.region')}
        className="order-1 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 slide-in-from-bottom-4 duration-200"
      >
        <ul className="max-h-[min(18rem,40dvh)] divide-y overflow-y-auto" aria-live="polite">
          {operations.map((e) => <Row key={e.op.id} entry={e} />)}
        </ul>
        {offline && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t('operations.status.offline')}</p>}
      </section>
    </DockPortal>
  );
}
