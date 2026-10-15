import type { SyncAccount } from '@synclet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Clock, Folder, LogOut, Share2, Trash2, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { NavLink, useNavigate } from 'react-router';
import { Wordmark } from '@/components/brand/Logo';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ThemeToggle } from './ThemeToggle';

interface NavEntry { to?: string; label: string; icon: LucideIcon }
const NAV: NavEntry[] = [
  { to: '/files', label: 'shell.myFiles', icon: Folder },
  { label: 'shell.recent', icon: Clock },
  { to: '/shared', label: 'shell.shared', icon: Share2 },
  { to: '/trash', label: 'shell.trash', icon: Trash2 },
];

const itemBase = 'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-13 shrink-0 items-center px-4 md:mt-2">
        <Wordmark />
      </div>
      <nav aria-label={t('shell.navigation')} className="px-2 pt-2">
        <ul className="flex flex-col gap-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <li key={label}>
              {to ? (
                <NavLink
                  to={to}
                  onClick={onNavigate}
                  className={({ isActive }) => cn(
                    itemBase,
                    'transition-colors duration-150',
                    isActive
                      ? 'bg-background text-foreground ring-1 ring-border [&_svg]:text-primary'
                      : 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{t(label)}</span>
                </NavLink>
              ) : (
                <span aria-disabled="true" className={cn(itemBase, 'cursor-default text-muted-foreground/80')}>
                  <Icon className="size-4 shrink-0 opacity-70" />
                  <span className="truncate">{t(label)}</span>
                  <Badge variant="outline" className="ml-auto h-4.5 px-1.5 text-[11px] font-medium text-muted-foreground">
                    {t('common.comingSoon')}
                  </Badge>
                </span>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-auto flex flex-col gap-3 p-2 pb-3">
        <StorageMeter />
        <UserMenu />
      </div>
    </div>
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

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
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
