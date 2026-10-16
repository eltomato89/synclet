import type { AdminUserWire } from '@synclet/shared';
import { Ban, CircleCheck, MonitorSmartphone, MoreHorizontal, PencilLine, Plus, UserX } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useTopbar } from '@/components/app-shell/Topbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAdminTitle } from './AdminLayout';
import { adminErrorKey } from './forms';
import { formatDateTime, formatRelative, notify } from './parts';
import { useAdminUsers, useUserMutations } from './queries';
import { UserDialog } from './UserDialog';

export const userPath = (id: string) => `/admin/users/${id}`;

/** Short label for a sign-in method: local password, OIDC (`oidc:<issuer>`) or the auth proxy (`forward`). */
export function identityLabel(provider: string): 'local' | 'oidc' | 'forward' | 'other' {
  if (provider === 'local') return 'local';
  if (provider.startsWith('oidc:')) return 'oidc';
  if (provider === 'forward') return 'forward';
  return 'other';
}

export function IdentityBadges({ user }: { user: AdminUserWire }) {
  const { t } = useTranslation();
  if (!user.identities.length) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {user.identities.map((i) => {
        const kind = identityLabel(i.provider);
        const title = kind === 'local' ? undefined : `${i.provider.replace(/^oidc:/, '')} (${i.subject})`;
        return (
          <Badge key={`${i.provider}:${i.subject}`} variant="outline" title={title} className="h-4.5 px-1.5 text-[11px] font-medium text-muted-foreground">
            {kind === 'other' ? i.provider : t(`admin.users.identity.${kind}`)}
          </Badge>
        );
      })}
    </span>
  );
}

type Confirm = { kind: 'disable' | 'enable' | 'delete'; user: AdminUserWire; open: boolean };

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { user: me } = useAuth();
  const users = useAdminUsers();
  const m = useUserMutations();
  const [dialog, setDialog] = useState<{ user?: AdminUserWire; open: boolean; n: number } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useAdminTitle(t('admin.nav.users'));

  const openDialog = (user?: AdminUserWire) => setDialog((c) => ({ user, open: true, n: (c?.n ?? 0) + 1 }));

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('admin.users.title')}</h1>
      <Button size="sm" onClick={() => openDialog()} className="shrink-0"><Plus />{t('admin.users.create')}</Button>
    </>,
  );

  const list = users.data;
  let body;
  if (!list && users.error) {
    body = (
      <StatusMessage title={t('admin.users.loadError')} body={t(adminErrorKey(users.error))}>
        <Button variant="outline" onClick={() => void users.refetch()} disabled={users.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!list) {
    body = <SkeletonRows view="list" />;
  } else {
    const active = list.filter((u) => !u.disabled).length;
    body = (
      <div className="pb-16">
        <table aria-label={t('admin.users.title')} className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-10 z-10 bg-background text-xs text-muted-foreground">
            <tr className="[&>th]:h-9 [&>th]:border-b [&>th]:px-2 [&>th]:text-left [&>th]:font-medium">
              <th scope="col" className="pl-3! md:pl-6!">{t('admin.users.columns.name')}</th>
              <th scope="col" className="hidden w-56 2xl:table-cell">{t('admin.users.columns.email')}</th>
              <th scope="col" className="w-28 max-sm:hidden">{t('admin.users.columns.roleStatus')}</th>
              <th scope="col" className="hidden w-24 text-right! md:table-cell">{t('admin.users.columns.storage')}</th>
              <th scope="col" className="hidden w-20 text-right! lg:table-cell">{t('admin.users.columns.devices')}</th>
              <th scope="col" className="hidden w-36 lg:table-cell">{t('admin.users.columns.lastLogin')}</th>
              <th scope="col" className="hidden w-40 xl:table-cell">{t('admin.users.columns.identities')}</th>
              <th scope="col" className="w-12 md:w-16"><span className="sr-only">{t('common.more')}</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => {
              const self = u.id === me?.id;
              return (
                <tr key={u.id} className="h-14 [&>td]:border-b [&>td]:border-border/70 [&>td]:transition-colors [&>td]:duration-100 hover:[&>td]:bg-accent/70">
                  <td className="pr-2 pl-3 md:pl-6">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Link
                        to={userPath(u.id)}
                        className={cn('truncate font-medium underline-offset-4 outline-none hover:underline focus-visible:underline', u.disabled ? 'text-muted-foreground' : 'text-foreground')}
                      >
                        {u.displayName}
                      </Link>
                      {self && <span className="shrink-0 text-xs text-muted-foreground">{t('admin.users.you')}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {u.username}
                      {u.email && <span className="2xl:hidden">, {u.email}</span>}
                    </div>
                  </td>
                  <td className="hidden truncate px-2 text-muted-foreground 2xl:table-cell" title={u.email ?? undefined}>{u.email ?? '–'}</td>
                  <td className="px-2 max-sm:hidden">
                    <span className="flex flex-col items-start gap-0.5">
                      <span className={cn('text-sm', u.role === 'admin' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                        {t(`admin.users.role.${u.role}`)}
                      </span>
                      {u.disabled && (
                        <Badge variant="destructive" className="h-4.5 px-1.5 text-[11px]">{t('admin.users.disabled')}</Badge>
                      )}
                    </span>
                  </td>
                  <td className="hidden px-2 text-right text-muted-foreground tabular-nums md:table-cell">{formatBytes(u.usedBytes, locale)}</td>
                  <td className="hidden px-2 text-right text-muted-foreground tabular-nums lg:table-cell">
                    {new Intl.NumberFormat(locale).format(u.devices)}
                  </td>
                  <td className="hidden truncate px-2 text-muted-foreground tabular-nums lg:table-cell" title={u.lastLoginAt ? formatDateTime(u.lastLoginAt, locale) : undefined}>
                    {u.lastLoginAt ? formatRelative(u.lastLoginAt, locale) : t('admin.users.never')}
                  </td>
                  <td className="hidden px-2 xl:table-cell"><IdentityBadges user={u} /></td>
                  <td className="pr-2 md:pr-4">
                    <div className="flex justify-end">
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={t('admin.users.actionsFor', { name: u.displayName })} className="text-muted-foreground hover:text-foreground">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onSelect={() => openDialog(u)}><PencilLine />{t('admin.users.edit')}</DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link to={userPath(u.id)}><MonitorSmartphone />{t('admin.users.access')}</Link>
                          </DropdownMenuItem>
                          {!self && (
                            <>
                              <DropdownMenuSeparator />
                              {u.disabled ? (
                                <DropdownMenuItem onSelect={() => setConfirm({ kind: 'enable', user: u, open: true })}>
                                  <CircleCheck />{t('admin.users.enable.action')}
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem onSelect={() => setConfirm({ kind: 'disable', user: u, open: true })}>
                                  <Ban />{t('admin.users.disable.action')}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: 'delete', user: u, open: true })}>
                                <UserX />{t('admin.users.delete.action')}
                              </DropdownMenuItem>
                            </>
                          )}
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
          {t('admin.users.count', { count: list.length, active })}
        </p>
      </div>
    );
  }

  return (
    <>
      {body}
      {dialog && (
        <UserDialog
          key={dialog.n}
          open={dialog.open}
          user={dialog.user}
          isSelf={!!dialog.user && dialog.user.id === me?.id}
          onOpenChange={(o) => { if (!o) setDialog((c) => (c ? { ...c, open: false } : c)); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
          title={t(`admin.users.${confirm.kind}.title`, { name: confirm.user.displayName })}
          body={t(`admin.users.${confirm.kind}.body`, { name: confirm.user.displayName, username: confirm.user.username })}
          confirmLabel={t(`admin.users.${confirm.kind}.submit`)}
          pendingLabel={t(`admin.users.${confirm.kind}.submitting`)}
          destructive={confirm.kind !== 'enable'}
          errorMessage={(err) => t(adminErrorKey(err))}
          onConfirm={async () => {
            const { kind, user } = confirm;
            if (kind === 'delete') await m.remove.mutateAsync(user.id);
            else await m.update.mutateAsync({ id: user.id, patch: { disabled: kind === 'disable' } });
            notify.success(t(`admin.users.${kind}.done`, { name: user.displayName }));
          }}
        />
      )}
    </>
  );
}
