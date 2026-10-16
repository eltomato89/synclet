import { MoreHorizontal, PencilLine, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTopbar } from '@/components/app-shell/Topbar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SkeletonRows, StatusMessage } from '@/features/files/EmptyState';
import { useAdminTitle } from './AdminLayout';
import { adminErrorKey } from './forms';
import { GroupDialog } from './GroupDialog';
import { notify } from './parts';
import { useAdminGroups, useGroupMutations } from './queries';
import type { GroupWire } from './types';

export function GroupsPage() {
  const { t } = useTranslation();
  const groups = useAdminGroups();
  const m = useGroupMutations();
  const [dialog, setDialog] = useState<{ group?: GroupWire; open: boolean; n: number } | null>(null);
  const [confirm, setConfirm] = useState<{ group: GroupWire; open: boolean } | null>(null);
  useAdminTitle(t('admin.nav.groups'));

  const openDialog = (group?: GroupWire) => setDialog((c) => ({ group, open: true, n: (c?.n ?? 0) + 1 }));

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('admin.groups.title')}</h1>
      <Button size="sm" onClick={() => openDialog()} className="shrink-0"><Plus />{t('admin.groups.create')}</Button>
    </>,
  );

  const list = groups.data;
  let body;
  if (!list && groups.error) {
    body = (
      <StatusMessage title={t('admin.groups.loadError')} body={t(adminErrorKey(groups.error))}>
        <Button variant="outline" onClick={() => void groups.refetch()} disabled={groups.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  } else if (!list) {
    body = <SkeletonRows view="list" />;
  } else if (list.length === 0) {
    body = <StatusMessage title={t('admin.groups.empty')} body={t('admin.groups.emptyBody')} />;
  } else {
    body = (
      <div className="pb-16">
        <table aria-label={t('admin.groups.title')} className="w-full table-fixed border-separate border-spacing-0 text-sm">
          <thead className="sticky top-10 z-10 bg-background text-xs text-muted-foreground">
            <tr className="[&>th]:h-9 [&>th]:border-b [&>th]:px-2 [&>th]:text-left [&>th]:font-medium">
              <th scope="col" className="w-56 pl-3! md:pl-6!">{t('admin.groups.columns.name')}</th>
              <th scope="col">{t('admin.groups.columns.members')}</th>
              <th scope="col" className="w-12 md:w-16"><span className="sr-only">{t('common.more')}</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.id} className="h-12 [&>td]:border-b [&>td]:border-border/70 hover:[&>td]:bg-accent/70">
                <td className="truncate pr-2 pl-3 font-medium md:pl-6">{g.name}</td>
                <td className="truncate px-2 text-muted-foreground" title={g.members.map((x) => x.displayName).join(', ')}>
                  {g.members.length ? g.members.map((x) => x.displayName).join(', ') : t('admin.groups.noMembers')}
                </td>
                <td className="pr-2 md:pr-4">
                  <div className="flex justify-end">
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t('admin.users.actionsFor', { name: g.name })} className="text-muted-foreground hover:text-foreground">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onSelect={() => openDialog(g)}><PencilLine />{t('admin.users.edit')}</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ group: g, open: true })}>
                          <Trash2 />{t('admin.groups.delete.action')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      {body}
      {dialog && (
        <GroupDialog
          key={dialog.n}
          open={dialog.open}
          group={dialog.group}
          onOpenChange={(o) => { if (!o) setDialog((c) => (c ? { ...c, open: false } : c)); }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open={confirm.open}
          onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
          title={t('admin.groups.delete.title', { name: confirm.group.name })}
          body={t('admin.groups.delete.body')}
          confirmLabel={t('admin.groups.delete.submit')}
          pendingLabel={t('admin.groups.delete.submitting')}
          destructive
          errorMessage={(err) => t(adminErrorKey(err))}
          onConfirm={async () => {
            await m.remove.mutateAsync(confirm.group.id);
            notify.success(t('admin.groups.delete.done', { name: confirm.group.name }));
          }}
        />
      )}
    </>
  );
}
