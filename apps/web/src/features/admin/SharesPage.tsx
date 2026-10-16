import type { AdminShareWire } from '@synclet/shared';
import { Copy, Trash2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useTopbar } from '@/components/app-shell/Topbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { FileIcon } from '@/features/files/FileIcon';
import { displayUrl, expiryText, formatDay, ShareBadges, useCopyLink } from '@/features/shares/parts';
import { shareStatus } from '@/features/shares/queries';
import { cn } from '@/lib/utils';
import { useAdminTitle } from './AdminLayout';
import { adminErrorKey } from './forms';
import { NativeSelect, notify } from './parts';
import { type ShareStatusFilter, useAdminShares, useAdminUsers, useRevokeAnyShare } from './queries';
import { userPath } from './UsersPage';

const FILTERS: ShareStatusFilter[] = ['active', 'expired', 'all'];

/** Every user's share links. Links of other users have no URL here (their tokens are not readable). */
export function SharesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [status, setStatus] = useState<ShareStatusFilter>('active');
  const [userId, setUserId] = useState('');
  const users = useAdminUsers();
  const shares = useAdminShares({ status, userId: userId || undefined });
  const revoke = useRevokeAnyShare();
  const [copy, manualCopy] = useCopyLink();
  const [confirm, setConfirm] = useState<{ share: AdminShareWire; open: boolean } | null>(null);
  useAdminTitle(t('admin.nav.shares'));

  useTopbar(<h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('admin.shares.title')}</h1>);

  const list = shares.data;
  let body;
  if (!list && shares.error) {
    body = (
      <StatusMessage title={t('admin.shares.loadError')} body={t(adminErrorKey(shares.error))}>
        <Button variant="outline" onClick={() => void shares.refetch()} disabled={shares.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!list) {
    body = <SkeletonRows view="list" />;
  } else if (list.length === 0) {
    body = <StatusMessage title={t(`admin.shares.none.${status}`)} body={userId ? t('admin.shares.noneForUser') : t('admin.shares.noneBody')} />;
  } else {
    body = (
      <div className={cn('pb-16 transition-opacity duration-150', shares.isPlaceholderData && 'opacity-60')}>
        <table aria-label={t('admin.shares.title')} className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-[5.75rem] z-10 bg-background text-xs text-muted-foreground">
            <tr className="[&>th]:h-9 [&>th]:border-b [&>th]:px-2 [&>th]:text-left [&>th]:font-medium">
              <th scope="col" className="pl-3! md:pl-6!">{t('shares.columns.item')}</th>
              <th scope="col" className="hidden w-36 sm:table-cell">{t('admin.shares.owner')}</th>
              <th scope="col" className="hidden w-36 lg:table-cell">{t('admin.shares.space')}</th>
              <th scope="col" className="hidden w-32 lg:table-cell">{t('shares.columns.created')}</th>
              <th scope="col" className="hidden w-44 md:table-cell">{t('shares.columns.expires')}</th>
              <th scope="col" className="hidden w-16 text-right! md:table-cell">{t('shares.columns.hits')}</th>
              <th scope="col" className="w-20 md:w-24"><span className="sr-only">{t('common.more')}</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const st = shareStatus(s);
              const dim = st !== 'active' || s.itemTrashed;
              const exp = st === 'revoked' ? t('admin.shares.revokedOn', { date: formatDay(s.revokedAt!, locale) }) : expiryText(s, t, locale);
              return (
                <tr key={s.id} className="h-14 [&>td]:border-b [&>td]:border-border/70 [&>td]:transition-colors [&>td]:duration-100 hover:[&>td]:bg-accent/70">
                  <td className="pr-2 pl-3 md:pl-6">
                    <div className="flex min-w-0 items-center gap-3">
                      <FileIcon item={{ type: s.itemType, name: s.itemName, mime: null }} className={cn('size-5', dim && 'opacity-50')} />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span title={s.itemName} className={cn('truncate font-medium', dim ? 'text-muted-foreground' : 'text-foreground')}>{s.itemName}</span>
                          {st === 'revoked' && (
                            <Badge variant="outline" className="h-4.5 shrink-0 px-1.5 text-[11px] font-medium text-muted-foreground">{t('admin.shares.revoked')}</Badge>
                          )}
                          {s.itemTrashed && (
                            <Badge variant="outline" title={t('shares.trashed.hint')} className="h-4.5 shrink-0 gap-1 px-1.5 text-[11px] font-medium text-muted-foreground">
                              <Trash2 />{t('shares.badges.trashed')}
                            </Badge>
                          )}
                          <span className="flex shrink-0 gap-1 max-sm:hidden"><ShareBadges share={s} /></span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground tabular-nums">
                          <span className="sm:hidden">{s.owner.username}, </span>
                          {s.url ? displayUrl(s.url) : <span className="md:hidden">{exp}</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden truncate px-2 sm:table-cell">
                    <Link to={userPath(s.owner.id)} className="text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:underline">
                      {s.owner.username}
                    </Link>
                  </td>
                  {/* Team folders and storages by name; a personal space (named after its user = the owner) stays empty. */}
                  <td data-testid="share-space" className="hidden truncate px-2 text-muted-foreground lg:table-cell" title={s.space && s.space.kind !== 'personal' ? s.space.name : undefined}>
                    {s.space && s.space.kind !== 'personal' ? s.space.name : ''}
                  </td>
                  <td className="hidden px-2 text-muted-foreground tabular-nums lg:table-cell">{formatDay(s.createdAt, locale)}</td>
                  <td className={cn('hidden truncate px-2 tabular-nums md:table-cell', st === 'expired' ? 'text-destructive' : 'text-muted-foreground')} title={exp}>{exp}</td>
                  <td className="hidden px-2 text-right text-muted-foreground tabular-nums md:table-cell">{new Intl.NumberFormat(locale).format(s.hits)}</td>
                  <td className="pr-2 md:pr-4">
                    <div className="flex items-center justify-end gap-0.5">
                      {s.url && st === 'active' && !s.itemTrashed && (
                        <Button variant="ghost" size="icon-sm" onClick={(e) => copy(s, e.currentTarget)} aria-label={t('shares.copyItem', { name: s.itemName })} title={t('shares.copy')} className="text-muted-foreground hover:text-foreground">
                          <Copy />
                        </Button>
                      )}
                      {st !== 'revoked' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setConfirm({ share: s, open: true })}
                          aria-label={t('admin.shares.revokeFor', { name: s.itemName, owner: s.owner.username })}
                          title={t('shares.revoke.action')}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Unlink />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-4 pt-4 text-xs text-muted-foreground tabular-nums md:px-6">{t('shares.page.count', { count: list.length })}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-10 z-10 flex h-13 flex-wrap items-center gap-x-3 gap-y-2 border-b bg-background px-3 md:px-6">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="max-sm:sr-only">{t('admin.shares.owner')}</span>
          <NativeSelect value={userId} onChange={(e) => setUserId(e.target.value)} className="max-w-48">
            <option value="">{t('admin.shares.allUsers')}</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
          </NativeSelect>
        </label>
        <ToggleGroup
          type="single"
          size="sm"
          spacing={0}
          value={status}
          aria-label={t('shares.page.filter')}
          onValueChange={(v) => { if (v) setStatus(v as ShareStatusFilter); }}
        >
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f} value={f} className="px-2.5 text-xs text-muted-foreground data-[state=on]:bg-muted data-[state=on]:text-foreground">
              {t(`shares.page.filters.${f}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {body}
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
          title={t('shares.revoke.title')}
          body={t('admin.shares.revokeBody', { name: confirm.share.itemName, owner: confirm.share.owner.username })}
          confirmLabel={t('shares.revoke.submit')}
          pendingLabel={t('shares.revoke.submitting')}
          destructive
          errorMessage={(err) => t(adminErrorKey(err))}
          onConfirm={async () => {
            await revoke.mutateAsync(confirm.share.id);
            notify.success(t('shares.toast.revoked'));
          }}
        />
      )}
      {manualCopy}
    </div>
  );
}
