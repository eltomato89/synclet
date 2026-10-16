import type { SyncItem } from '@synclet/shared';
import { Folder, MoreHorizontal } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { PERSONAL, spaceOfItem } from '@/features/spaces/useSpaces';
import { cn } from '@/lib/utils';
import { folderPath } from './queries';

const MAX_VISIBLE = 4;

/**
 * Folder path, root first ("My files" or the space name). With more than four segments the middle ones collapse into a menu;
 * on small screens only the current folder stays visible and every parent moves into the menu.
 */
export function Breadcrumbs({ chain }: { chain: SyncItem[] | undefined }) {
  const { t } = useTranslation();
  if (!chain) return <Skeleton className="h-4 w-40" />;
  if (chain.length === 0) return null;

  // The personal root reads "My files"; the root of any other space carries the space name.
  const label = (item: SyncItem) => (item.kind === 'root' && spaceOfItem(item) === PERSONAL ? t('shell.myFiles') : item.name);
  const n = chain.length;
  const collapsed = n > MAX_VISIBLE ? chain.slice(1, n - 2) : [];
  const parents = chain.slice(0, n - 1);

  const menu = (items: SyncItem[], className: string) => (
    <BreadcrumbItem className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('files.showPath')}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-72">
          {items.map((item) => (
            <DropdownMenuItem key={item.id} asChild>
              <Link to={folderPath(item.id)}>
                <Folder className="text-muted-foreground" />
                <span className="truncate">{label(item)}</span>
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </BreadcrumbItem>
  );

  return (
    <Breadcrumb aria-label={t('files.breadcrumb')} className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1 sm:gap-1.5">
        {n > 1 && menu(parents, 'sm:hidden')}
        {n > 1 && <BreadcrumbSeparator className="sm:hidden" />}
        {chain.map((item, i) => {
          const last = i === n - 1;
          if (collapsed.includes(item)) {
            return i === 1 ? (
              <Fragment key="collapsed">
                {menu(collapsed, 'max-sm:hidden')}
                <BreadcrumbSeparator className="max-sm:hidden" />
              </Fragment>
            ) : null;
          }
          return (
            <Fragment key={item.id}>
              <BreadcrumbItem className={cn('min-w-0', !last && 'max-sm:hidden')}>
                {last ? (
                  <BreadcrumbPage className="truncate text-base font-semibold tracking-[-0.01em]">{label(item)}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild className="max-w-48 truncate rounded-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <Link to={folderPath(item.id)}>{label(item)}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator className="max-sm:hidden" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
