import type { TrashEntryWire } from '@synclet/shared';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useTopbar } from '@/components/app-shell/Topbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { errorKey } from '@/features/files/errors';
import { FileIcon } from '@/features/files/FileIcon';
import { folderPath } from '@/features/files/queries';
import { ApiError } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { expiresIn, parentSegments, retentionDays, useTrash, useTrashMutations } from './queries';

type Confirm = { kind: 'delete'; entry: TrashEntryWire } | { kind: 'empty'; count: number };

/** i18n key for a failed trash request. */
function trashErrorKey(err: unknown): string {
  if (err instanceof ApiError && err.code === 'conflict') return 'trash.errors.conflict';
  if (err instanceof ApiError && err.code === 'not_found') return 'trash.errors.not_found';
  return errorKey(err);
}

export function TrashPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const navigate = useNavigate();
  const trash = useTrash();
  const m = useTrashMutations();
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<(Confirm & { open: boolean }) | null>(null);
  const entries = trash.data ?? [];

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('shell.trash')} – Synclet`;
    return () => { document.title = prev; };
  }, [t]);

  const location = (path: string) => [t('shell.myFiles'), ...parentSegments(path)].join(' / ');

  const mark = (id: string, on: boolean) => setBusy((s) => {
    const next = new Set(s);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  async function restore(entry: TrashEntryWire) {
    mark(entry.id, true);
    try {
      const r = await m.restore.mutateAsync(entry);
      const where = location(r.restoredTo);
      toast.success(
        r.renamed ? t('trash.toast.restoredAs', { name: entry.name, newName: r.item.name }) : t('trash.toast.restored', { name: entry.name }),
        {
          position: 'bottom-center',
          description: r.renamed ? t('trash.toast.renamedHint', { location: where }) : t('trash.toast.location', { location: where }),
          action: { label: t('trash.toast.show'), onClick: () => navigate(folderPath(r.item.parentId ?? 'root')) },
        },
      );
    } catch (err) {
      toast.error(t(trashErrorKey(err)), { position: 'bottom-center' });
    } finally {
      mark(entry.id, false);
    }
  }

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('shell.trash')}</h1>
      {entries.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirm({ kind: 'empty', count: entries.length, open: true })}
        >
          <Trash2 />{t('trash.empty.action')}
        </Button>
      )}
    </>,
  );

  let body;
  if (!trash.data && trash.error) {
    body = (
      <StatusMessage title={t('trash.loadError')} body={t(errorKey(trash.error))}>
        <Button variant="outline" onClick={() => void trash.refetch()} disabled={trash.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!trash.data) {
    body = <SkeletonRows view="list" />;
  } else if (entries.length === 0) {
    body = (
      <div className="p-4 md:p-6">
        <div className="flex min-h-[min(26rem,60dvh)] flex-col items-start justify-end rounded-2xl border border-dashed border-foreground/15 p-6 md:p-10">
          <h2 className="text-2xl font-semibold text-foreground">{t('trash.emptyState.title')}</h2>
          <p className="mt-2 max-w-[46ch] text-base text-muted-foreground">{t('trash.emptyState.body')}</p>
        </div>
      </div>
    );
  } else {
    const total = entries.reduce((n, e) => n + e.size, 0);
    const days = retentionDays(entries);
    body = (
      <div className="pb-16">
        <table aria-label={t('shell.trash')} className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-background text-xs font-medium text-muted-foreground">
            <tr className="[&>th]:h-9 [&>th]:border-b [&>th]:px-2 [&>th]:text-left [&>th]:font-medium">
              <th scope="col" className="pl-3! md:pl-6!">{t('files.columns.name')}</th>
              <th scope="col" className="hidden w-[24%] md:table-cell">{t('trash.columns.location')}</th>
              <th scope="col" className="hidden w-32 lg:table-cell">{t('trash.columns.deleted')}</th>
              <th scope="col" className="hidden w-24 text-right! sm:table-cell">{t('files.columns.size')}</th>
              <th scope="col" className="hidden w-32 sm:table-cell">{t('trash.columns.expires')}</th>
              <th scope="col" className="w-20 sm:w-44"><span className="sr-only">{t('common.more')}</span></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const pending = busy.has(e.id);
              const exp = expiresIn(e.expiresAt);
              const expText = exp.kind === 'never' ? null : exp.kind === 'today' ? t('trash.expiresToday') : t('trash.expiresIn', { count: exp.days });
              const urgent = exp.kind === 'today' || (exp.kind === 'days' && exp.days <= 3);
              const size = formatBytes(e.size, locale);
              const where = location(e.originalPath);
              return (
                <tr
                  key={e.id}
                  className={cn(
                    'group/row h-12 sm:h-11 [&>td]:border-b [&>td]:border-border/70 [&>td]:transition-colors [&>td]:duration-100 hover:[&>td]:bg-accent/70',
                    pending && 'opacity-60',
                  )}
                >
                  <td className="pr-2 pl-3 md:pl-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <FileIcon item={{ type: e.type, name: e.name, mime: null }} className="size-5" />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground" title={e.name}>{e.name}</div>
                        <div className="truncate text-xs text-muted-foreground tabular-nums md:hidden" title={where}>
                          <span className="sm:hidden">{expText ? `${expText}, ${size}` : size}</span>
                          <span className="max-sm:hidden">{where}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden truncate px-2 text-muted-foreground md:table-cell" title={where}>{where}</td>
                  <td className="hidden px-2 text-muted-foreground tabular-nums lg:table-cell">{formatDate(e.deletedAt, locale)}</td>
                  <td className="hidden px-2 text-right text-muted-foreground tabular-nums sm:table-cell">{size}</td>
                  <td
                    className={cn('hidden px-2 tabular-nums sm:table-cell', urgent ? 'text-foreground' : 'text-muted-foreground', exp.kind === 'today' && 'text-destructive')}
                    title={e.expiresAt ? new Date(e.expiresAt).toLocaleString(locale) : t('trash.keptForever')}
                  >
                    {expText ?? <span aria-label={t('trash.keptForever')}>–</span>}
                  </td>
                  <td className="pr-2 md:pr-4">
                    <div className="flex items-center justify-end gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => void restore(e)}
                            aria-label={t('trash.restoreItem', { name: e.name })}
                            className="text-muted-foreground hover:text-foreground max-sm:size-8 max-sm:px-0"
                          >
                            <RotateCcw /><span className="max-sm:hidden">{t('trash.restore')}</span>
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="sm:hidden">{t('trash.restore')}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={pending}
                            onClick={() => setConfirm({ kind: 'delete', entry: e, open: true })}
                            aria-label={t('trash.deleteItem', { name: e.name })}
                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          >
                            <X />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t('trash.deleteForever')}</TooltipContent>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="max-w-[80ch] px-4 pt-4 text-xs text-muted-foreground tabular-nums md:px-6">
          {t('trash.summary', { count: entries.length, size: formatBytes(total, locale) })}
          {days !== null && days > 0 && <> {t('trash.retention', { count: days })}</>}
        </p>
      </div>
    );
  }

  const c = confirm;
  const close = (o: boolean) => { if (!o) setConfirm((cur) => (cur ? { ...cur, open: false } : cur)); };
  return (
    <div className="flex min-h-full flex-col">
      {body}
      {c?.kind === 'delete' && (
        <ConfirmDialog
          open={c.open}
          onOpenChange={close}
          title={t('trash.deleteDialog.title', { name: c.entry.name })}
          body={c.entry.type === 'folder' ? t('trash.deleteDialog.folderBody') : t('trash.deleteDialog.fileBody')}
          confirmLabel={t('trash.deleteForever')}
          pendingLabel={t('trash.deleteDialog.submitting')}
          destructive
          errorMessage={(err) => t(trashErrorKey(err))}
          onConfirm={async () => {
            await m.deleteForever.mutateAsync(c.entry);
            toast.success(t('trash.toast.deleted', { name: c.entry.name }), { position: 'bottom-center' });
          }}
        />
      )}
      {c?.kind === 'empty' && (
        <ConfirmDialog
          open={c.open}
          onOpenChange={close}
          title={t('trash.empty.title')}
          body={t('trash.empty.body', { count: c.count })}
          confirmLabel={t('trash.empty.action')}
          pendingLabel={t('trash.empty.submitting')}
          destructive
          errorMessage={(err) => t(trashErrorKey(err))}
          onConfirm={async () => {
            const { removed } = await m.empty.mutateAsync();
            toast.success(t('trash.toast.emptied', { count: removed }), { position: 'bottom-center' });
          }}
        />
      )}
    </div>
  );
}
