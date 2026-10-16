import type { SyncAccount } from '@synclet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Clock, Folder, Lock, LogOut, Share2, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useNavigate } from 'react-router';
import { Wordmark } from '@/components/brand/Logo';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SpaceIcon } from '@/features/spaces/SpaceIcon';
import {
  isUnavailable, PERSONAL, useCurrentSpaceId, useSpaces, useUnavailableSpaces,
} from '@/features/spaces/useSpaces';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { cn, initials } from '@/lib/utils';
import { ThemeToggle } from './ThemeToggle';

interface NavEntry { to: string; label: string; icon: LucideIcon }
const NAV: NavEntry[] = [
  { to: '/files', label: 'shell.myFiles', icon: Folder },
  { to: '/recent', label: 'shell.recent', icon: Clock },
  { to: '/shared', label: 'shell.shared', icon: Share2 },
  { to: '/trash', label: 'shell.trash', icon: Trash2 },
];

const ADMIN_NAV: NavEntry = { to: '/admin', label: 'shell.administration', icon: ShieldCheck };

const itemBase = 'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50';
const itemState = (active: boolean) => cn(
  itemBase,
  'transition-colors duration-150',
  active
    ? 'bg-background text-foreground ring-1 ring-border [&_svg]:text-primary'
    : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
);

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const currentSpace = useCurrentSpaceId();
  const entries = user?.role === 'admin' ? [...NAV, ADMIN_NAV] : NAV;
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-13 shrink-0 items-center px-4 md:mt-2">
        <Wordmark />
      </div>
      <nav aria-label={t('shell.navigation')} className="px-2 pt-2">
        <ul className="flex flex-col gap-0.5">
          {entries.map(({ to, label, icon: Icon }) => (
            <li key={label} className={cn(to === ADMIN_NAV.to && 'mt-3 border-t border-sidebar-border pt-3')}>
              {to === '/files' ? (
                // Every space lives under /files: "My files" is active only inside the personal space.
                <Link
                  to={to}
                  onClick={onNavigate}
                  aria-current={currentSpace === PERSONAL ? 'page' : undefined}
                  className={itemState(currentSpace === PERSONAL)}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{t(label)}</span>
                </Link>
              ) : (
                <NavLink to={to} onClick={onNavigate} className={({ isActive }) => itemState(isActive)}>
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{t(label)}</span>
                </NavLink>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <SpacesNav current={currentSpace} onNavigate={onNavigate} />
      <div className="mt-auto flex flex-col gap-3 p-2 pb-3">
        <StorageMeter />
        <UserMenu />
      </div>
    </div>
  );
}

/** "Spaces": one entry per team folder and external storage the user can access. */
function SpacesNav({ current, onNavigate }: { current: string | null; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { spaces } = useSpaces();
  const unavailable = useUnavailableSpaces();
  const others = spaces.filter((s) => s.kind !== 'personal');
  if (others.length === 0) return null;
  return (
    <nav aria-labelledby="sidebar-spaces" className="min-h-0 overflow-y-auto px-2 pt-4">
      <h2 id="sidebar-spaces" className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">{t('spaces.section')}</h2>
      <ul className="flex flex-col gap-0.5">
        {others.map((s) => {
          const active = current === s.id;
          const off = isUnavailable(unavailable, s.id);
          return (
            <li key={s.id}>
              <Link
                to={`/files/${s.rootId}`}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                title={s.name}
                className={cn(itemState(active), off && 'text-muted-foreground')}
              >
                <SpaceIcon kind={s.kind} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {off && <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{t('spaces.unavailable')}</span>}
                {!s.canWrite && !off && (
                  <Lock role="img" aria-label={t('spaces.readOnly')} className="size-3 shrink-0 text-muted-foreground" />
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function StorageMeter() {
  const { t, i18n } = useTranslation();
  const { data, isPending, isError } = useQuery({
    queryKey: ['account'],
    queryFn: () => api<SyncAccount>('/sync/v1/account'),
  });
  if (isError) return null;
  const locale = i18n.language;
  const hasQuota = !!data && data.quotaBytes > 0;
  const percent = hasQuota ? Math.min(100, (data.usedBytes / data.quotaBytes) * 100) : 0;
  return (
    <div className="px-2.5">
      <div className="mb-1.5 text-xs font-medium text-foreground">{t('shell.storage')}</div>
      {isPending ? (
        <Skeleton className="h-4 w-24" />
      ) : (
        <>
          {hasQuota && <Progress value={percent} className="mb-1.5 h-1 bg-border" aria-label={t('shell.storage')} />}
          <p className="text-xs text-muted-foreground tabular-nums">
            {hasQuota
              ? t('shell.storageOf', { used: formatBytes(data.usedBytes, locale), quota: formatBytes(data.quotaBytes, locale) })
              : t('shell.storageUsed', { used: formatBytes(data?.usedBytes ?? 0, locale) })}
          </p>
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  if (!user) return null;
  const onLogout = async () => {
    await logout();
    queryClient.clear();
    navigate('/login', { replace: true });
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition-colors duration-150 hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-sidebar-accent"
      >
        <Avatar className="size-7 rounded-md">
          <AvatarFallback className="rounded-md bg-accent-soft text-[11px] font-semibold text-primary">
            {initials(user.displayName || user.username)}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{user.displayName}</span>
          <span className="block truncate text-xs text-muted-foreground">{user.username}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{user.displayName}</span>
            {user.role === 'admin' && (
              <Badge variant="secondary" className="h-4.5 px-1.5 text-[11px]">{t('shell.administrator')}</Badge>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{user.email ?? user.username}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeToggle />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void onLogout()}>
          <LogOut className="text-muted-foreground" />
          {t('shell.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
