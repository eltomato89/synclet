import { FolderMinus, MoreHorizontal, PencilLine, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTopbar } from '@/components/app-shell/Topbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { formatBytes } from '@/lib/format';
import { useAdminTitle } from './AdminLayout';
import { adminErrorKey } from './forms';
import { notify } from './parts';
import { useAdminSpaces, useSpaceMutations } from './queries';
import { SpaceDialog } from './SpaceDialog';
import type { SpaceWire } from './types';

export const MOUNT_DOCS = 'https://github.com/eltomato89/synclet/blob/main/deploy/README.md#team-ordner-und-externe-speicher';

function MembersSummary({ space }: { space: SpaceWire }) {
  const { t } = useTranslation();
  if (!space.members.length) return <span className="text-muted-foreground">{t('admin.spaces.noMembers')}</span>;
  const text = space.members.map((m) => `${m.name} (${t(`admin.spaces.members.role.${m.role}`)})`).join(', ');
  return <span title={text} className="text-muted-foreground">{t('admin.spaces.membersCount', { count: space.members.length })}</span>;
}

export function SpacesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const spaces = useAdminSpaces();
  const m = useSpaceMutations();
  const [dialog, setDialog] = useState<{ space?: SpaceWire; open: boolean; n: number } | null>(null);
  const [confirm, setConfirm] = useState<{ space: SpaceWire; open: boolean } | null>(null);
  useAdminTitle(t('admin.nav.spaces'));

  const openDialog = (space?: SpaceWire) => setDialog((c) => ({ space, open: true, n: (c?.n ?? 0) + 1 }));

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('admin.spaces.title')}</h1>
      <Button size="sm" onClick={() => openDialog()} className="shrink-0"><Plus />{t('admin.spaces.create')}</Button>
    </>,
  );

  async function scan(s: SpaceWire) {
    try {
      await m.scan.mutateAsync(s.id);
      notify.success(t('admin.spaces.toast.scanned', { name: s.name }));
    } catch (err) {
      notify.error(t(adminErrorKey(err)));
    }
  }

  const list = spaces.data;
  let body;
  if (!list && spaces.error) {
    body = (
      <StatusMessage title={t('admin.spaces.loadError')} body={t(adminErrorKey(spaces.error))}>
        <Button variant="outline" onClick={() => void spaces.refetch()} disabled={spaces.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!list) {
    body = <SkeletonRows view="list" />;
  } else {
    body = (
      <div className="pb-16">
        {list.length === 0 && <p className="px-4 pt-6 text-sm text-muted-foreground md:px-6">{t('admin.spaces.empty')}</p>}
        {list.length > 0 && (
          <table aria-label={t('admin.spaces.title')} className="w-full table-fixed border-separate border-spacing-0 text-sm">
            <thead className="sticky top-10 z-10 bg-background text-xs text-muted-foreground">
              <tr className="[&>th]:h-9 [&>th]:border-b [&>th]:px-2 [&>th]:text-left [&>th]:font-medium">
                <th scope="col" className="pl-3! md:pl-6!">{t('admin.spaces.columns.name')}</th>
                <th scope="col" className="hidden w-48 lg:table-cell">{t('admin.spaces.columns.path')}</th>
                <th scope="col" className="w-36">{t('admin.spaces.columns.status')}</th>
                <th scope="col" className="hidden w-24 text-right! md:table-cell">{t('admin.spaces.columns.size')}</th>
                <th scope="col" className="hidden w-28 sm:table-cell">{t('admin.spaces.columns.members')}</th>
                <th scope="col" className="w-12 md:w-16"><span className="sr-only">{t('common.more')}</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="h-14 [&>td]:border-b [&>td]:border-border/70 hover:[&>td]:bg-accent/70">
                  <td className="pr-2 pl-3 md:pl-6">
                    <div className="truncate font-medium">{s.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{t(`admin.spaces.kind.${s.kind}`)}</div>
                  </td>
                  <td className="hidden truncate px-2 font-mono text-xs text-muted-foreground lg:table-cell" title={s.rootPath}>{s.rootPath}</td>
                  <td className="px-2">
                    <span className="flex flex-wrap gap-1">
                      <Badge variant={s.status === 'available' ? 'secondary' : 'destructive'} className="h-4.5 px-1.5 text-[11px]">
                        {t(`admin.spaces.status.${s.status}`)}
                      </Badge>
                      {s.readOnly && <Badge variant="outline" className="h-4.5 px-1.5 text-[11px]">{t('admin.spaces.readOnly')}</Badge>}
                    </span>
                  </td>
                  <td className="hidden px-2 text-right text-muted-foreground tabular-nums md:table-cell">{formatBytes(s.sizeBytes, locale)}</td>
                  <td className="hidden truncate px-2 sm:table-cell"><MembersSummary space={s} /></td>
                  <td className="pr-2 md:pr-4">
                    <div className="flex justify-end">
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={t('admin.users.actionsFor', { name: s.name })} className="text-muted-foreground hover:text-foreground">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onSelect={() => openDialog(s)}><PencilLine />{t('admin.users.edit')}</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void scan(s)}><RefreshCw />{t('admin.spaces.scan')}</DropdownMenuItem>
                          {s.kind === 'team' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ space: s, open: true })}>
                                <FolderMinus />{t('admin.spaces.remove.action')}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-4 pt-4 text-xs text-muted-foreground md:px-6">
          {t('admin.spaces.mountHint')}{' '}
          <a href={MOUNT_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">
            {t('admin.spaces.mountLink')}
          </a>
        </p>
      </div>
    );
  }

  return (
    <>
      {body}
      {dialog && (
        <SpaceDialog
          key={dialog.n}
          open={dialog.open}
          space={dialog.space}
          onOpenChange={(o) => { if (!o) setDialog((c) => (c ? { ...c, open: false } : c)); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
          title={t('admin.spaces.remove.title', { name: confirm.space.name })}
          body={t('admin.spaces.remove.body')}
          confirmLabel={t('admin.spaces.remove.submit')}
          pendingLabel={t('admin.spaces.remove.submitting')}
          destructive
          errorMessage={(err) => t(adminErrorKey(err))}
          onConfirm={async () => {
            await m.remove.mutateAsync(confirm.space.id);
            notify.success(t('admin.spaces.remove.done', { name: confirm.space.name }));
          }}
        />
      )}
    </>
  );
}
