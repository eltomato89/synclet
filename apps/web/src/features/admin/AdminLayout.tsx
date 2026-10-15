import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { NotFoundPage } from '@/pages/NotFoundPage';

/** Admin routes render the regular 404 page for everyone else, so the area doesn't reveal itself. */
export function RequireAdmin() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <NotFoundPage />;
  return <Outlet />;
}

const TABS = [
  { to: '/admin/users', label: 'admin.nav.users' },
  { to: '/admin/status', label: 'admin.nav.status' },
  { to: '/admin/shares', label: 'admin.nav.shares' },
  { to: '/admin/sso', label: 'admin.nav.sso' },
] as const;

/** Sets the document title for an admin page. */
export function useAdminTitle(title: string) {
  const { t } = useTranslation();
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} – ${t('admin.title')} – Synclet`;
    return () => { document.title = prev; };
  }, [title, t]);
}

/** Section tabs above every admin page; the page owns the topbar and the content below. */
export function AdminLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col">
      <nav aria-label={t('admin.title')} className="sticky top-0 z-20 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-6">
        <ul className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                className={({ isActive }) => cn(
                  'flex h-10 items-center border-b-2 px-2.5 text-sm font-medium whitespace-nowrap outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                  isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(tab.label)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
