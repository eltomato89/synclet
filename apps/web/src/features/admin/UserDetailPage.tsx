import type { AdminDeviceWire, AdminSessionWire } from '@synclet/shared';
import { ChevronLeft, LogOut, PencilLine } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useTopbar } from '@/components/app-shell/Topbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusMessage } from '@/features/files/EmptyState';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { useAdminTitle } from './AdminLayout';
import { adminErrorKey } from './forms';
import { formatDateTime, formatRelative, notify, Section, useDescribeUserAgent } from './parts';
import { useAccessMutations, useAdminUsers, useUserDevices, useUserSessions } from './queries';
import { UserDialog } from './UserDialog';
import { IdentityBadges } from './UsersPage';

type Confirm =
  | { kind: 'session'; session: AdminSessionWire; open: boolean }
  | { kind: 'allSessions'; open: boolean }
  | { kind: 'device'; device: AdminDeviceWire; open: boolean };

const PLATFORMS: Record<AdminDeviceWire['platform'], string> = {
  ios: 'iOS', android: 'Android', macos: 'macOS', windows: 'Windows', linux: 'Linux', web: 'Web',
};

/** One user's open sessions (web logins) and sync devices, each revocable. */
export function UserDetailPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { user: me } = useAuth();
  const users = useAdminUsers();
  const sessions = useUserSessions(id);
  const devices = useUserDevices(id);
  const m = useAccessMutations(id);
  const ua = useDescribeUserAgent();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [edit, setEdit] = useState<{ open: boolean; n: number } | null>(null);
  const user = users.data?.find((u) => u.id === id);
  useAdminTitle(user?.displayName ?? t('admin.nav.users'));

  useTopbar(
    <>
      <Button variant="ghost" size="icon-sm" asChild className="-ml-1 shrink-0 text-muted-foreground">
        <Link to="/admin/users" aria-label={t('admin.detail.back')}><ChevronLeft /></Link>
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{user?.displayName ?? t('admin.users.title')}</h1>
      {user && (
        <Button size="sm" variant="outline" onClick={() => setEdit((c) => ({ open: true, n: (c?.n ?? 0) + 1 }))} className="shrink-0">
          <PencilLine />{t('admin.users.edit')}
        </Button>
      )}
    </>,
  );

  if (users.data && !user) {
    return (
      <StatusMessage title={t('admin.detail.notFound')} body={t('admin.detail.notFoundBody')}>
        <Button variant="outline" asChild><Link to="/admin/users">{t('admin.detail.back')}</Link></Button>
      </StatusMessage>
    );
  }
  if (!user && users.error) {
    return <StatusMessage title={t('admin.users.loadError')} body={t(adminErrorKey(users.error))} />;
  }

  const self = id === me?.id;

  return (
    <div className="px-4 py-6 md:px-6">
      <header className="mb-8 border-b pb-6">
        {user ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-foreground">{user.displayName}</h2>
              {user.role === 'admin' && <Badge variant="secondary" className="h-5 px-2">{t('admin.users.role.admin')}</Badge>}
              {user.disabled && <Badge variant="destructive" className="h-5 px-2">{t('admin.users.disabled')}</Badge>}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-[repeat(auto-fill,minmax(10rem,1fr))]">
              <Fact label={t('admin.users.form.username')}>{user.username}</Fact>
              <Fact label={t('admin.users.columns.email')}>{user.email ?? '–'}</Fact>
              <Fact label={t('admin.users.columns.storage')}>{formatBytes(user.usedBytes, locale)}</Fact>
              <Fact label={t('admin.detail.created')}>{formatDateTime(user.createdAt, locale)}</Fact>
              <Fact label={t('admin.users.columns.lastLogin')}>
                {user.lastLoginAt ? formatDateTime(user.lastLoginAt, locale) : t('admin.users.never')}
              </Fact>
              <Fact label={t('admin.users.columns.identities')}><IdentityBadges user={user} /></Fact>
            </dl>
          </>
        ) : (
          <div aria-hidden><Skeleton className="h-7 w-48" /><Skeleton className="mt-4 h-10 w-full max-w-xl" /></div>
        )}
      </header>

      <Section
        id="sessions"
        title={t('admin.detail.sessions')}
        description={self ? t('admin.detail.sessionsSelf') : t('admin.detail.sessionsHint')}
        actions={sessions.data && sessions.data.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setConfirm({ kind: 'allSessions', open: true })}>
            <LogOut />{t('admin.detail.revokeAll')}
          </Button>
        )}
      >
        <AccessTable
          loading={sessions.isPending}
          error={sessions.error}
          empty={t('admin.detail.noSessions')}
          label={t('admin.detail.sessions')}
          head={[t('admin.detail.client'), t('admin.detail.signedIn'), t('admin.detail.expires')]}
          rows={(sessions.data ?? []).map((s) => ({
            id: s.id,
            cells: [
              <span key="ua" className="block truncate font-medium text-foreground" title={s.userAgent ?? undefined}>{ua(s.userAgent)}</span>,
              <span key="c" title={formatDateTime(s.createdAt, locale)}>{formatRelative(s.createdAt, locale)}</span>,
              <span key="e" title={formatDateTime(s.expiresAt, locale)}>{formatRelative(s.expiresAt, locale)}</span>,
            ],
            action: (
              <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: 'session', session: s, open: true })} className="text-muted-foreground hover:text-destructive"
                aria-label={t('admin.detail.revokeSessionFor', { client: ua(s.userAgent) })}
              >
                {t('admin.detail.revoke')}
              </Button>
            ),
          }))}
        />
      </Section>

      <Section id="devices" title={t('admin.detail.devices')} description={t('admin.detail.devicesHint')} className="border-t">
        <AccessTable
          loading={devices.isPending}
          error={devices.error}
          empty={t('admin.detail.noDevices')}
          label={t('admin.detail.devices')}
          head={[t('admin.detail.device'), t('admin.detail.app'), t('admin.detail.lastSeen')]}
          rows={(devices.data ?? []).map((d) => ({
            id: d.id,
            cells: [
              <span key="n" className="block min-w-0">
                <span className="block truncate font-medium text-foreground" title={d.name}>{d.name}</span>
                <span className="block text-xs text-muted-foreground">{PLATFORMS[d.platform] ?? d.platform}</span>
              </span>,
              <span key="v" className="tabular-nums">{d.appVersion}</span>,
              <span key="l" title={d.lastSeenAt ? formatDateTime(d.lastSeenAt, locale) : undefined}>
                {d.lastSeenAt ? formatRelative(d.lastSeenAt, locale) : t('admin.users.never')}
              </span>,
            ],
            action: (
              <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: 'device', device: d, open: true })} className="text-muted-foreground hover:text-destructive"
                aria-label={t('admin.detail.revokeDeviceFor', { name: d.name })}
              >
                {t('admin.detail.revoke')}
              </Button>
            ),
          }))}
        />
      </Section>

      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
          title={t(`admin.detail.confirm.${confirm.kind}.title`)}
          body={t(`admin.detail.confirm.${confirm.kind}.body`, {
            name: user?.displayName ?? '',
            client: confirm.kind === 'session' ? ua(confirm.session.userAgent) : '',
            device: confirm.kind === 'device' ? confirm.device.name : '',
          })}
          confirmLabel={t(`admin.detail.confirm.${confirm.kind}.submit`)}
          pendingLabel={t('admin.detail.revoking')}
          destructive
          errorMessage={(err) => t(adminErrorKey(err))}
          onConfirm={async () => {
            if (confirm.kind === 'session') await m.revokeSession.mutateAsync(confirm.session.id);
            else if (confirm.kind === 'allSessions') await m.revokeAllSessions.mutateAsync();
            else await m.revokeDevice.mutateAsync(confirm.device.id);
            await Promise.all([sessions.refetch(), devices.refetch()]);
            notify.success(t(`admin.detail.confirm.${confirm.kind}.done`));
          }}
        />
      )}
      {edit && user && (
        <UserDialog
          key={edit.n}
          open={edit.open}
          user={user}
          isSelf={self}
          onOpenChange={(o) => { if (!o) setEdit((c) => (c ? { ...c, open: false } : c)); }}
        />
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-foreground">{children}</dd>
    </div>
  );
}

function AccessTable({ loading, error, empty, label, head, rows }: {
  loading: boolean;
  error: unknown;
  empty: string;
  label: string;
  head: [string, string, string];
  rows: { id: string; cells: ReactNode[]; action: ReactNode }[];
}) {
  const { t } = useTranslation();
  if (loading) {
    return <div aria-hidden className="flex flex-col gap-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>;
  }
  if (error && !rows.length) return <p className="text-sm text-destructive">{t(adminErrorKey(error))}</p>;
  if (!rows.length) return <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-lg border">
      <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-sm">
        <thead className="bg-canvas text-xs text-muted-foreground">
          <tr className="[&>th]:h-8 [&>th]:border-b [&>th]:px-3 [&>th]:text-left [&>th]:font-medium">
            <th scope="col">{head[0]}</th>
            <th scope="col" className="hidden w-36 sm:table-cell">{head[1]}</th>
            <th scope="col" className="hidden w-36 md:table-cell">{head[2]}</th>
            <th scope="col" className="w-28"><span className="sr-only">{t('common.more')}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="h-12 text-muted-foreground tabular-nums [&:not(:last-child)>td]:border-b [&>td]:border-border/70">
              <td className="min-w-0 px-3">{r.cells[0]}</td>
              <td className="hidden truncate px-3 sm:table-cell">{r.cells[1]}</td>
              <td className="hidden truncate px-3 md:table-cell">{r.cells[2]}</td>
              <td className="px-2 text-right">{r.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
