import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { OperationsPanel } from '@/features/operations/OperationsPanel';
import { OperationsProvider } from '@/features/operations/OperationsProvider';
import { PanelDock } from './PanelDock';
import { Sidebar } from './Sidebar';
import { Topbar, TopbarProvider } from './Topbar';

/**
 * App frame: the sidebar sits on the Fog canvas, page content on an inset Paper panel.
 * `<main id="main">` is the scroll container; pages own their padding.
 * Below `md` the sidebar moves into a sheet opened from the topbar.
 */
export function AppShell() {
  const { t } = useTranslation();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  return (
    <TopbarProvider>
      <OperationsProvider>
        <PanelDock>
          <a
            href="#main"
            className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium ring-1 ring-border focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
          >
            {t('shell.skipToContent')}
          </a>
          <div className="flex h-dvh bg-canvas">
            <aside className="hidden w-60 shrink-0 md:block">
              <Sidebar />
            </aside>
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetContent side="left" aria-describedby={undefined} className="w-72 max-w-[85vw] gap-0 border-r-0 bg-canvas p-0">
                <SheetTitle className="sr-only">{t('shell.navigation')}</SheetTitle>
                <Sidebar onNavigate={() => setNavOpen(false)} />
              </SheetContent>
            </Sheet>
            <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
              <div className="flex min-h-0 flex-1 flex-col bg-background md:rounded-xl md:border">
                <Topbar onOpenNavigation={() => setNavOpen(true)} />
                <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto outline-none">
                  <Outlet />
                </main>
              </div>
            </div>
          </div>
          <OperationsPanel />
        </PanelDock>
      </OperationsProvider>
    </TopbarProvider>
  );
}
