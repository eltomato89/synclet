import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { nameConflictKey, validateSpaceName } from './forms';
import { notify } from './parts';
import { useAdminUsers, useGroupMutations } from './queries';
import type { GroupWire } from './types';
import { Field } from './UserDialog';

/** Create a group or edit its name and members. */
export function GroupDialog({ open, onOpenChange, group }: { open: boolean; onOpenChange(open: boolean): void; group?: GroupWire }) {
  const { t } = useTranslation();
  const ids = useId();
  const m = useGroupMutations();
  const users = useAdminUsers();
  const [name, setName] = useState(group?.name ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(() => group?.members.map((x) => x.id) ?? []);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [server, setServer] = useState<{ field: 'name' | null; message: string } | null>(null);

  const nameError = validateSpaceName(name);
  const shownName = submitted && nameError ? t(`admin.spaces.form.errors.${nameError}`) : server?.field === 'name' ? server.message : undefined;
  const toggle = (id: string, on: boolean) => setMemberIds((c) => (on ? [...c, id] : c.filter((x) => x !== id)));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameError || pending) return;
    setPending(true);
    setServer(null);
    try {
      if (group) await m.update.mutateAsync({ id: group.id, patch: { name: name.trim(), memberIds } });
      else await m.create.mutateAsync({ name: name.trim(), memberIds });
      notify.success(t(group ? 'admin.groups.toast.updated' : 'admin.groups.toast.created', { name: name.trim() }));
      onOpenChange(false);
    } catch (err) {
      const { key, field } = nameConflictKey(err);
      setServer({ field, message: t(key) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {group ? t('admin.groups.form.editTitle', { name: group.name }) : t('admin.groups.form.createTitle')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <Field id={`${ids}-name`} label={t('admin.groups.form.name')} error={shownName}>
            <Input
              id={`${ids}-name`} value={name} autoFocus autoComplete="off"
              aria-invalid={shownName ? true : undefined}
              aria-describedby={shownName ? `${ids}-name-error` : undefined}
              onChange={(e) => { setName(e.target.value); setServer(null); }}
            />
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">{t('admin.groups.form.members')}</legend>
            <div className="flex max-h-52 flex-col overflow-y-auto rounded-lg border p-1">
              {!users.data ? (
                <p className="p-1.5 text-xs text-muted-foreground">{t('common.loading')}</p>
              ) : users.data.map((u) => (
                <label key={u.id} className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm hover:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
                  <input type="checkbox" checked={memberIds.includes(u.id)} onChange={(e) => toggle(u.id, e.target.checked)} className="size-4 accent-primary" />
                  <span className="truncate font-medium">{u.displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">{u.username}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <FormError>{server && !server.field ? server.message : null}</FormError>
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={pending}>
              {group ? (pending ? t('admin.users.form.saving') : t('common.save')) : (pending ? t('admin.groups.form.creating') : t('admin.groups.form.create'))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
