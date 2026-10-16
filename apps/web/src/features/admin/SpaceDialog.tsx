import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { adminErrorKey, type MemberRow, validateSpaceName } from './forms';
import { MembersEditor, SELECT_CLASS } from './MembersEditor';
import { notify } from './parts';
import { useAdminGroups, useAdminUsers, useSpaceMutations } from './queries';
import type { SpacePatch, SpaceWire } from './types';
import { Field } from './UserDialog';

const wireMembers = (rows: MemberRow[]): NonNullable<SpacePatch['members']> => rows.map((r) => ({ kind: r.kind, id: r.id, role: r.role }));

/** Create a team folder, or edit a space (name for team folders; watch mode and scan interval for external storages). */
export function SpaceDialog({ open, onOpenChange, space }: { open: boolean; onOpenChange(open: boolean): void; space?: SpaceWire }) {
  const { t } = useTranslation();
  const ids = useId();
  const m = useSpaceMutations();
  const users = useAdminUsers();
  const groups = useAdminGroups();
  const external = space?.kind === 'external';
  const [name, setName] = useState(space?.name ?? '');
  const [watch, setWatch] = useState<'auto' | 'off'>(space?.watch ?? 'auto');
  const [interval, setIntervalText] = useState(space?.scanIntervalSec ? String(space.scanIntervalSec) : '');
  const [members, setMembers] = useState<MemberRow[]>(() => (space?.members ?? []).map((x) => ({ ...x })));
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [server, setServer] = useState<{ field: 'name' | null; message: string } | null>(null);

  const nameError = external ? null : validateSpaceName(name);
  const intervalNum = interval.trim() === '' ? null : Number(interval);
  const intervalError = intervalNum !== null && (!Number.isInteger(intervalNum) || intervalNum < 1);
  const shownName = submitted && nameError ? t(`admin.spaces.form.errors.${nameError}`) : server?.field === 'name' ? server.message : undefined;
  const shownInterval = submitted && intervalError ? t('admin.spaces.form.errors.interval') : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (nameError || intervalError || pending) return;
    setPending(true);
    setServer(null);
    try {
      if (!space) {
        const created = await m.create.mutateAsync({ name: name.trim() });
        if (members.length) await m.update.mutateAsync({ id: created.id, patch: { members: wireMembers(members) } });
        notify.success(t('admin.spaces.toast.created', { name: name.trim() }));
      } else {
        const patch: SpacePatch = external ? { watch, scanIntervalSec: intervalNum } : name.trim() !== space.name ? { name: name.trim() } : {};
        await m.update.mutateAsync({ id: space.id, patch: { ...patch, members: wireMembers(members) } });
        notify.success(t('admin.spaces.toast.updated', { name: space.name }));
      }
      onOpenChange(false);
    } catch (err) {
      setServer({ field: external ? null : 'name', message: t(adminErrorKey(err)) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {space ? t('admin.spaces.form.editTitle', { name: space.name }) : t('admin.spaces.form.createTitle')}
          </DialogTitle>
          <DialogDescription>{space ? space.rootPath : t('admin.spaces.form.createDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto px-0.5">
          {!external && (
            <Field id={`${ids}-name`} label={t('admin.spaces.form.name')} hint={t('admin.spaces.form.nameHint')} error={shownName}>
              <Input
                id={`${ids}-name`} value={name} autoFocus autoComplete="off"
                aria-invalid={shownName ? true : undefined}
                aria-describedby={shownName ? `${ids}-name-error` : `${ids}-name-hint`}
                onChange={(e) => { setName(e.target.value); setServer(null); }}
              />
            </Field>
          )}
          {external && (
            <>
              <Field id={`${ids}-watch`} label={t('admin.spaces.form.watch')} hint={t('admin.spaces.form.watchHint')}>
                <select id={`${ids}-watch`} value={watch} onChange={(e) => setWatch(e.target.value as 'auto' | 'off')} className={`${SELECT_CLASS} w-full`}>
                  <option value="auto">{t('admin.spaces.watch.auto')}</option>
                  <option value="off">{t('admin.spaces.watch.off')}</option>
                </select>
              </Field>
              <Field id={`${ids}-interval`} label={t('admin.spaces.form.interval')} hint={t('admin.spaces.form.intervalHint')} error={shownInterval}>
                <Input
                  id={`${ids}-interval`} type="number" min={1} inputMode="numeric" value={interval}
                  aria-invalid={shownInterval ? true : undefined}
                  onChange={(e) => setIntervalText(e.target.value)}
                />
              </Field>
            </>
          )}
          <MembersEditor value={members} onChange={setMembers} users={users.data ?? []} groups={groups.data ?? []} />
          <FormError>{server && !server.field ? server.message : null}</FormError>
          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={pending}>
              {space ? (pending ? t('admin.users.form.saving') : t('common.save')) : (pending ? t('admin.spaces.form.creating') : t('admin.spaces.form.create'))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
