import type { AdminUserWire } from '@synclet/shared';
import { FolderInput } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import {
  adminErrorKey, hasErrors, PASSWORD_MIN, type UserFormErrors, type UserFormValues, userErrorField, validateUserForm,
} from './forms';
import { notify } from './parts';
import { type UserPatch, useUnassignedFolders, useUserMutations } from './queries';

function initial(user?: AdminUserWire): UserFormValues {
  return {
    displayName: user?.displayName ?? '', username: user?.username ?? '', email: user?.email ?? '', password: '',
    role: user?.role ?? 'user', adopt: false,
  };
}

/** Only what changed, so an unrelated edit never trips the last-admin check. */
export function userPatch(user: AdminUserWire, v: UserFormValues): UserPatch {
  const patch: UserPatch = {};
  if (v.displayName.trim() !== user.displayName) patch.displayName = v.displayName.trim();
  const email = v.email.trim() || null;
  if (email !== user.email) patch.email = email;
  if (v.role !== user.role) patch.role = v.role;
  if (v.password) patch.password = v.password;
  return patch;
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Create a user (optionally taking over an existing folder in the data directory) or edit one. */
export function UserDialog({ open, onOpenChange, user, isSelf }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Edit mode when given. */
  user?: AdminUserWire;
  isSelf?: boolean;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const m = useUserMutations();
  const mode = user ? 'edit' : 'create';
  const [v, setV] = useState<UserFormValues>(() => initial(user));
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [server, setServer] = useState<{ field?: string; message: string } | null>(null);
  const folders = useUnassignedFolders(open && mode === 'create');

  const errors = validateUserForm(v, mode);
  const shown: UserFormErrors = submitted ? errors : {};
  const set = (patch: Partial<UserFormValues>) => { setV((c) => ({ ...c, ...patch })); setServer(null); };
  const err = (field: keyof UserFormErrors) => {
    if (server?.field === field) return server.message;
    const key = shown[field];
    return key ? t(`admin.users.form.errors.${key}`, { count: PASSWORD_MIN }) : undefined;
  };
  const describe = (id: string, field: keyof UserFormErrors, hint?: boolean) =>
    err(field) ? `${id}-error` : hint ? `${id}-hint` : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(errors) || pending) return;
    setPending(true);
    setServer(null);
    try {
      if (user) {
        const patch = userPatch(user, v);
        if (Object.keys(patch).length) await m.update.mutateAsync({ id: user.id, patch });
        notify.success(t('admin.users.toast.updated', { name: v.displayName.trim() }));
      } else {
        await m.create.mutateAsync({
          username: v.username, displayName: v.displayName.trim(), email: v.email.trim() || null, password: v.password, role: v.role,
          ...(v.adopt ? { adoptExistingFolder: true } : {}),
        });
        notify.success(t('admin.users.toast.created', { name: v.displayName.trim() }));
      }
      onOpenChange(false);
    } catch (e2) {
      setServer({ field: userErrorField(e2), message: t(adminErrorKey(e2)) });
    } finally {
      setPending(false);
    }
  }

  const f = {
    name: `${ids}-name`, username: `${ids}-username`, email: `${ids}-email`, password: `${ids}-password`, folder: `${ids}-folder`,
  };
  const list = folders.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {user ? t('admin.users.form.editTitle', { name: user.displayName }) : t('admin.users.form.createTitle')}
          </DialogTitle>
          <DialogDescription>{user ? t('admin.users.form.editDescription', { username: user.username }) : t('admin.users.form.createDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {mode === 'create' && (
            <div className="rounded-lg border">
              <div className="flex items-start gap-4 p-3">
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${ids}-adopt`} className="block cursor-pointer text-sm font-medium text-foreground">{t('admin.users.form.adopt')}</label>
                  <p id={`${ids}-adopt-hint`} className="mt-0.5 text-xs text-muted-foreground">{t('admin.users.form.adoptHint')}</p>
                </div>
                <Switch
                  id={`${ids}-adopt`}
                  checked={v.adopt}
                  aria-describedby={`${ids}-adopt-hint`}
                  onCheckedChange={(adopt) => set({ adopt, username: '' })}
                  className="mt-0.5"
                />
              </div>
              {v.adopt && (
                <div className="border-t p-1.5">
                  {folders.isPending ? (
                    <div aria-hidden className="flex flex-col gap-1 p-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-28" /></div>
                  ) : folders.isError ? (
                    <p className="p-1.5 text-xs text-destructive">{t(adminErrorKey(folders.error))}</p>
                  ) : list.length === 0 ? (
                    <p className="p-1.5 text-xs text-muted-foreground">{t('admin.users.form.noFolders')}</p>
                  ) : (
                    <div
                      role="radiogroup"
                      aria-label={t('admin.users.form.folder')}
                      aria-describedby={err('username') ? `${f.folder}-error` : undefined}
                      className="flex max-h-44 flex-col overflow-y-auto"
                    >
                      {list.map((folder) => {
                        const checked = v.username === folder.name;
                        return (
                          <label
                            key={folder.name}
                            className={cn(
                              'flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-100 has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
                              checked ? 'bg-accent-soft text-foreground' : 'hover:bg-accent',
                            )}
                          >
                            <input
                              type="radio"
                              name={f.folder}
                              value={folder.name}
                              checked={checked}
                              onChange={() => set({ username: folder.name, ...(v.displayName.trim() ? {} : { displayName: folder.name }) })}
                              className="sr-only"
                            />
                            <FolderInput className={cn('size-4 shrink-0', checked ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                            <span className="truncate font-medium">{folder.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {err('username') && <p id={`${f.folder}-error`} className="px-1.5 pb-1 text-xs text-destructive">{err('username')}</p>}
                </div>
              )}
            </div>
          )}

          <Field id={f.name} label={t('admin.users.form.displayName')} error={err('displayName')}>
            <Input
              id={f.name}
              value={v.displayName}
              autoComplete="off"
              autoFocus
              aria-invalid={err('displayName') ? true : undefined}
              aria-describedby={describe(f.name, 'displayName')}
              onChange={(e) => set({ displayName: e.target.value })}
            />
          </Field>

          {mode === 'create' && !v.adopt && (
            <Field id={f.username} label={t('admin.users.form.username')} hint={t('admin.users.form.usernameHint')} error={err('username')}>
              <Input
                id={f.username}
                value={v.username}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={err('username') ? true : undefined}
                aria-describedby={describe(f.username, 'username', true)}
                onChange={(e) => set({ username: e.target.value })}
              />
            </Field>
          )}

          <Field id={f.email} label={t('admin.users.form.email')} hint={t('admin.users.form.emailHint')} error={err('email')}>
            <Input
              id={f.email}
              type="email"
              value={v.email}
              autoComplete="off"
              aria-invalid={err('email') ? true : undefined}
              aria-describedby={describe(f.email, 'email', true)}
              onChange={(e) => set({ email: e.target.value })}
            />
          </Field>

          <Field
            id={f.password}
            label={mode === 'create' ? t('admin.users.form.password') : t('admin.users.form.newPassword')}
            hint={mode === 'create' ? t('admin.users.form.passwordHint', { count: PASSWORD_MIN }) : t('admin.users.form.newPasswordHint', { count: PASSWORD_MIN })}
            error={err('password')}
          >
            <PasswordInput
              id={f.password}
              value={v.password}
              autoComplete="new-password"
              aria-invalid={err('password') ? true : undefined}
              aria-describedby={describe(f.password, 'password', true)}
              onChange={(e) => set({ password: e.target.value })}
            />
          </Field>

          <div>
            <span id={`${ids}-role`} className="mb-1.5 block text-sm font-medium text-foreground">{t('admin.users.form.role')}</span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={v.role}
              onValueChange={(r) => { if (r) set({ role: r as 'admin' | 'user' }); }}
              aria-labelledby={`${ids}-role`}
              className="flex w-full"
            >
              {(['user', 'admin'] as const).map((r) => (
                <ToggleGroupItem
                  key={r}
                  value={r}
                  disabled={isSelf && r === 'user'}
                  className="flex-1 text-xs text-muted-foreground data-[state=on]:bg-accent-soft data-[state=on]:text-foreground"
                >
                  {t(`admin.users.role.${r}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {isSelf ? t('admin.users.form.roleSelf') : t(`admin.users.form.roleHint.${v.role}`)}
            </p>
          </div>

          <FormError>{server && !server.field ? server.message : server?.field === 'role' ? server.message : null}</FormError>

          <DialogFooter className="mt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={pending}>
              {mode === 'create'
                ? (pending ? t('admin.users.form.creating') : t('admin.users.form.create'))
                : (pending ? t('admin.users.form.saving') : t('common.save'))}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
