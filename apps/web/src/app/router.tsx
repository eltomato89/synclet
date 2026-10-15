import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import { AppShell } from '@/components/app-shell/AppShell';
import { ConnectionError } from '@/components/ConnectionError';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { useAuth } from '@/lib/auth';
import { SharedPage } from '@/features/shares/SharedPage';
import { TrashPage } from '@/features/trash/TrashPage';
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

export const router = createBrowserRouter([
  { path: '/setup', element: <SetupPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/', element: <Navigate to="/files" replace /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/files', element: <FilesPage /> },
          { path: '/files/:folderId', element: <FilesPage /> },
          { path: '/shared', element: <SharedPage /> },
          { path: '/trash', element: <TrashPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
