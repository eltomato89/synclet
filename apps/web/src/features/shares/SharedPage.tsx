import type { ShareLinkWire } from '@synclet/shared';
import { Copy, MoreHorizontal, PencilLine, RefreshCw, Unlink } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useTopbar } from '@/components/app-shell/Topbar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { errorKey } from '@/features/files/errors';
import { FileIcon } from '@/features/files/FileIcon';
import { folderPath } from '@/features/files/queries';
import { cn } from '@/lib/utils';
import { displayUrl, expiryText, formatDay, ShareBadges, ShareConfirm, type ShareConfirmAction, useCopyLink } from './parts';
import { shareStatus, useShares } from './queries';

const ShareDialog = lazy(() => import('./ShareDialog').then((m) => ({ default: m.ShareDialog })));

const FILTERS = ['active', 'expired', 'all'] as const;
type Filter = (typeof FILTERS)[number];

export function filterShares(list: ShareLinkWire[], filter: Filter, now: number = Date.now()): ShareLinkWire[] {
  return filter === 'all' ? list : list.filter((s) => shareStatus(s, now) === filter);
}

export function SharedPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const shares = useShares();
  const [copy, manualCopy] = useCopyLink();
  const [filter, setFilter] = useState<Filter>('active');
  const [edit, setEdit] = useState<{ share: ShareLinkWire; open: boolean; n: number } | null>(null);
  const [confirm, setConfirm] = useState<(ShareConfirmAction & { open: boolean }) | null>(null);
  const all = shares.data;
  const visible = useMemo(() => filterShares(all ?? [], filter), [all, filter]);

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('shell.shared')} – Synclet`;
    return () => { document.title = prev; };
  }, [t]);

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('shares.page.title')}</h1>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0}
        value={filter}
        aria-label={t('shares.page.filter')}
        onValueChange={(v) => { if (v) setFilter(v as Filter); }}
        className="shrink-0"
      >
        {FILTERS.map((f) => (
          <ToggleGroupItem
            key={f}
            value={f}
            className="px-2.5 text-xs text-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground"
          >
            {t(`shares.page.filters.${f}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>,
  );

  const onRotated = (share: ShareLinkWire) => toast.success(t('shares.toast.rotated'), {
    position: 'bottom-center',
    action: { label: t('shares.copy'), onClick: () => copy(share) },
  });

  let body;
  if (!all && shares.error) {
    body = (
      <StatusMessage title={t('shares.page.loadError')} body={t(errorKey(shares.error))}>
        <Button variant="outline" onClick={() => void shares.refetch()} disabled={shares.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!all) {
    body = <SkeletonRows view="list" />;
  } else if (all.length === 0) {
    body = (
      <div className="p-4 md:p-6">
        <div className="flex min-h-[min(26rem,60dvh)] flex-col items-start justify-end rounded-2xl border border-dashed border-foreground/15 p-6 md:p-10">
          <h2 className="text-2xl font-semibold text-foreground">{t('shares.page.emptyTitle')}</h2>
          <p className="mt-2 max-w-[46ch] text-base text-muted-foreground">{t('shares.page.emptyBody')}</p>
          <Button variant="outline" asChild className="mt-6"><Link to="/files">{t('shares.page.goToFiles')}</Link></Button>
        </div>
      </div>
    );
  } else if (visible.length === 0) {
    body = <StatusMessage title={t(`shares.page.noneTitle.${filter}`)} body={t('shares.page.noneBody')} />;
  } else {
    body = (
      <div className="pb-16">
        <table aria-label={t('shares.page.title')} className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
            <tr className="[&>th]:h-9 [&>th]:border-b [&>th]:px-2 [&>th]:text-left [&>th]:font-medium">
              <th scope="col" className="pl-3! md:pl-6!">{t('shares.columns.item')}</th>
              <th scope="col" className="hidden w-32 lg:table-cell">{t('shares.columns.created')}</th>
              <th scope="col" className="hidden w-44 sm:table-cell">{t('shares.columns.expires')}</th>
              <th scope="col" className="hidden w-20 text-right! md:table-cell">{t('shares.columns.hits')}</th>
              <th scope="col" className="w-20 md:w-24"><span className="sr-only">{t('common.more')}</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const expired = shareStatus(s) === 'expired';
              const item = { type: s.itemType, name: s.itemName, mime: null };
              const exp = expiryText(s, t, locale);
              return (
                <tr key={s.id} className="h-14 [&>td]:border-b [&>td]:border-border/70 [&>td]:transition-colors [&>td]:duration-100 hover:[&>td]:bg-accent/70">
                  <td className="pr-2 pl-3 md:pl-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <FileIcon item={item} className={cn('size-5', expired && 'opacity-50')} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {s.itemType === 'folder' ? (
                            <Link
                              to={folderPath(s.itemId)}
                              title={s.itemName}
                              className={cn('truncate font-medium underline-offset-4 outline-none hover:underline focus-visible:underline', expired ? 'text-muted-foreground' : 'text-foreground')}
                            >
                              {s.itemName}
                            </Link>
                          ) : (
                            <span title={s.itemName} className={cn('truncate font-medium', expired ? 'text-muted-foreground' : 'text-foreground')}>{s.itemName}</span>
                          )}
                          <span className="flex shrink-0 gap-1 max-sm:hidden"><ShareBadges share={s} /></span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground tabular-nums">
                          <span className="sm:hidden">{exp}</span>
                          <span className="max-sm:hidden">{s.url ? displayUrl(s.url) : t('shares.errors.noUrlShort')}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-2 text-muted-foreground tabular-nums lg:table-cell">{formatDay(s.createdAt, locale)}</td>
                  <td className={cn('hidden truncate px-2 tabular-nums sm:table-cell', expired ? 'text-destructive' : 'text-muted-foreground')} title={exp}>{exp}</td>
                  <td className="hidden px-2 text-right text-muted-foreground tabular-nums md:table-cell">
                    {new Intl.NumberFormat(locale).format(s.hits)}
                  </td>
                  <td className="pr-2 md:pr-4">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => copy(s)}
                        disabled={!s.url || expired}
                        aria-label={t('shares.copyItem', { name: s.itemName })}
                        title={t('shares.copy')}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Copy />
                      </Button>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={t('shares.linkActionsFor', { name: s.itemName })} className="text-muted-foreground hover:text-foreground">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onSelect={() => setEdit((cur) => ({ share: s, open: true, n: (cur?.n ?? 0) + 1 }))}>
                            <PencilLine />{t('shares.edit')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setConfirm({ kind: 'rotate', share: s, open: true })}>
                            <RefreshCw />{t('shares.rotate.action')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: 'revoke', share: s, open: true })}>
                            <Unlink />{t('shares.revoke.action')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-4 pt-4 text-xs text-muted-foreground tabular-nums md:px-6">
          {t('shares.page.count', { count: visible.length })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      {body}
      <Suspense fallback={null}>
        {edit && (
          <ShareDialog
            key={edit.n}
            open={edit.open}
            onOpenChange={(o) => { if (!o) setEdit((cur) => (cur ? { ...cur, open: false } : cur)); }}
            item={{ id: edit.share.itemId, name: edit.share.itemName, type: edit.share.itemType }}
            editShare={edit.share}
          />
        )}
      </Suspense>
      <ShareConfirm
        action={confirm}
        open={!!confirm?.open}
        onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
        onRotated={onRotated}
      />
      {manualCopy}
    </div>
  );
}
