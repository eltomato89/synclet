import type { SyncItem, VersionWire } from '@synclet/shared';
import { Download, Eye, RotateCcw } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorKey } from '@/features/files/errors';
import { formatBytes } from '@/lib/format';
import i18n from '@/lib/i18n';
import { downloadVersion, useRestoreVersion, useVersions } from './queries';
import { canPreviewVersion, revokeVersionBlobs, versionPreviewSource } from './source';

const QuickLook = lazy(() => import('@/features/preview/QuickLook').then((m) => ({ default: m.QuickLook })));

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400], ['month', 30 * 86400], ['week', 7 * 86400], ['day', 86400], ['hour', 3600], ['minute', 60],
];

/** "3 hours ago" in the UI language; anything under a minute is "now". */
export function relativeTime(iso: string, locale: string, now = Date.now()): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'second');
}

const absoluteTime = (iso: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));

/**
 * Side sheet with the earlier versions of one file. Rendered only when the server reports that
 * versions are enabled (the caller decides); each row can be previewed, downloaded or restored.
 */
export function VersionsPanel({ item, open, onOpenChange, onRestored, onClosed }: {
  item: SyncItem; open: boolean; onOpenChange(open: boolean): void; onRestored?(item: SyncItem): void;
  /** After the sheet closes: move focus back (the menu that opened it is gone). */
  onClosed?(): void;
}) {
  const { t } = useTranslation();
  const versions = useVersions(item.id, open);
  const restore = useRestoreVersion(item);
  const [confirm, setConfirm] = useState<VersionWire | null>(null);
  const [preview, setPreview] = useState<VersionWire | null>(null);
  const locale = i18n.language;
  const previewable = canPreviewVersion(item);
  // Restoring writes the file: not for read-only spaces (listing, preview and download need read only).
  const canRestore = item.capabilities.write !== false;

  useEffect(() => { if (!open) revokeVersionBlobs(); }, [open]);
  useEffect(() => revokeVersionBlobs, []);

  const download = (v: VersionWire) => {
    downloadVersion(item.id, v.id).catch((err: unknown) => toast.error(t(errorKey(err)), { position: 'bottom-center' }));
  };

  const list = versions.data ?? [];
  let body;
  if (versions.isPending) {
    body = <div className="space-y-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  } else if (versions.isError) {
    body = (
      <div className="flex flex-col items-start gap-3 p-4 text-sm">
        <p className="text-muted-foreground">{t('versions.loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => void versions.refetch()}>{t('common.retry')}</Button>
      </div>
    );
  } else if (!list.length) {
    body = (
      <div className="px-4 py-10 text-sm">
        <p className="font-medium">{t('versions.emptyTitle')}</p>
        <p className="mt-1 max-w-[32ch] text-muted-foreground">{t('versions.emptyBody')}</p>
      </div>
    );
  } else {
    body = (
      <ol className="divide-y overflow-y-auto" aria-label={t('versions.title')}>
        {list.map((v) => (
          <li key={v.id} className="flex items-start gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium tabular-nums">{t('versions.number', { n: v.version })}</span>
                {v.source !== 'api' && <Badge variant="secondary">{t(`versions.source.${v.source}`)}</Badge>}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <time dateTime={v.modifiedAt} tabIndex={0} className="block w-fit rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {relativeTime(v.modifiedAt, locale)}
                  </time>
                </TooltipTrigger>
                <TooltipContent>{absoluteTime(v.modifiedAt, locale)}</TooltipContent>
              </Tooltip>
              <p className="truncate text-xs text-muted-foreground tabular-nums">
                {formatBytes(v.size, locale)}{v.createdBy ? `, ${v.createdBy.displayName}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              {previewable && <RowButton label={t('versions.preview', { n: v.version })} onClick={() => setPreview(v)}><Eye /></RowButton>}
              <RowButton label={t('versions.download', { n: v.version })} onClick={() => download(v)}><Download /></RowButton>
              {canRestore && <RowButton label={t('versions.restore', { n: v.version })} onClick={() => setConfirm(v)}><RotateCcw /></RowButton>}
            </div>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          className="gap-0 data-[side=right]:sm:max-w-md"
          onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed(); } }}
        >
          <SheetHeader className="border-b pr-12">
            <SheetTitle className="break-all">{t('versions.title')}</SheetTitle>
            <SheetDescription className="break-all">{t('versions.description', { name: item.name })}</SheetDescription>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={(o) => { if (!o) setConfirm(null); }}
          title={t('versions.confirmTitle', { n: confirm.version })}
          body={t('versions.confirmBody')}
          confirmLabel={t('versions.restoreAction')}
          pendingLabel={t('versions.restoring')}
          errorMessage={(err) => t(errorKey(err))}
          onConfirm={async () => {
            const restored = await restore.mutateAsync(confirm.id);
            toast.success(t('versions.restored', { n: confirm.version }), { position: 'bottom-center' });
            onRestored?.(restored);
          }}
        />
      )}
      {preview && (
        <Suspense fallback={null}>
          <QuickLook
            entries={[{ id: preview.id, name: item.name, size: preview.size, mime: item.mime, modifiedAt: preview.modifiedAt }]}
            activeId={preview.id}
            open
            onActiveChange={() => undefined}
            onOpenChange={(o) => { if (!o) { setPreview(null); revokeVersionBlobs(); } }}
            resolveSource={() => versionPreviewSource(item, preview)}
            onDownload={() => download(preview)}
          />
        </Suspense>
      )}
    </>
  );
}

function RowButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="text-muted-foreground hover:text-foreground">
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
