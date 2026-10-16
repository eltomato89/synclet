import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, Outlet, type RouteObject, useLocation } from 'react-router';
import { AppShell } from '@/components/app-shell/AppShell';
import { ConnectionError } from '@/components/ConnectionError';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { AdminLayout, RequireAdmin } from '@/features/admin/AdminLayout';
import { AppLoginPage } from '@/features/auth/AppLoginPage';
import { PublicSharePage } from '@/features/public/PublicSharePage';
import { RecentPage } from '@/features/recent/RecentPage';
import { SharedPage } from '@/features/shares/SharedPage';
import { TrashPage } from '@/features/trash/TrashPage';
import { AuthProvider, useAuth } from '@/lib/auth';
import { FilesPage } from '@/pages/FilesPage';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { SetupPage } from '@/pages/SetupPage';

function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'error') return <ConnectionError />;
  if (status === 'needs-setup') return <Navigate to="/setup" replace />;
  if (status === 'anonymous') {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

/**
 * Session context for the app routes only. The public share page lives outside it, so visiting a
 * share link never probes, refreshes or redirects a session (no `/api/auth/*` or setup calls).
 */
function AuthRoot() {
  return <AuthProvider><Outlet /></AuthProvider>;
}

/** Route `lazy` loader for a named page export (keeps the admin area out of the main bundle). */
function lazyPage<M>(load: () => Promise<M>, name: keyof M) {
  return async () => ({ Component: (await load())[name] as ComponentType });
}

const adminChildren: RouteObject[] = [
  { index: true, element: <Navigate to="/admin/users" replace /> },
  { path: 'users', lazy: lazyPage(() => import('@/features/admin/UsersPage'), 'UsersPage') },
  { path: 'users/:id', lazy: lazyPage(() => import('@/features/admin/UserDetailPage'), 'UserDetailPage') },
  { path: 'groups', lazy: lazyPage(() => import('@/features/admin/GroupsPage'), 'GroupsPage') },
  { path: 'spaces', lazy: lazyPage(() => import('@/features/admin/SpacesPage'), 'SpacesPage') },
  { path: 'status', lazy: lazyPage(() => import('@/features/admin/StatusPage'), 'StatusPage') },
  { path: 'shares', lazy: lazyPage(() => import('@/features/admin/SharesPage'), 'SharesPage') },
  { path: 'sso', lazy: lazyPage(() => import('@/features/admin/SsoPage'), 'SsoPage') },
];

export const routes: RouteObject[] = [
  { path: '/s/:token', element: <PublicSharePage /> },
  {
    element: <AuthRoot />,
    // Shown while a lazy route (admin pages) loads on a direct visit.
    hydrateFallbackElement: <FullPageSpinner />,
    children: [
      { path: '/setup', element: <SetupPage /> },
      { path: '/login', element: <LoginPage /> },
      // Native app sign-in: uses the session if there is one, but never requires it.
      { path: '/app-login', element: <AppLoginPage /> },
      { path: '/', element: <Navigate to="/files" replace /> },
      {
        element: <RequireAuth />,
        children: [
          // Full-screen editor in its own tab, without the app chrome.
          {
            path: '/office/:itemId',
            lazy: () => import('@/features/office/OfficeEditorPage').then((m) => ({ Component: m.OfficeEditorPage })),
          },
          {
            element: <AppShell />,
            children: [
              { path: '/files', element: <FilesPage /> },
              { path: '/files/:folderId', element: <FilesPage /> },
              { path: '/recent', element: <RecentPage /> },
              { path: '/shared', element: <SharedPage /> },
              { path: '/trash', element: <TrashPage /> },
            ],
          },
          {
            // Non-admins get the plain 404 page, outside the app shell.
            element: <RequireAdmin />,
            children: [
              {
                element: <AppShell />,
                children: [{ path: '/admin', element: <AdminLayout />, children: adminChildren }],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];

export const router = createBrowserRouter(routes);
