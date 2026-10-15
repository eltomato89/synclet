import type { ShareLinkWire } from '@synclet/shared';
import { Check, Copy, Link2, MoreHorizontal, PencilLine, Plus, RefreshCw, Unlink } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FileIcon } from '@/features/files/FileIcon';
import { cn } from '@/lib/utils';
import {
  createPayload, EXPIRY_CHOICES, type ExpiryChoice, hasErrors, initialValues, PASSWORD_MIN, patchPayload,
  type ShareFormContext, type ShareFormValues, toDateInput, validateShareForm,
} from './form';
import { displayUrl, expiryText, formatDay, notify, ShareBadges, ShareConfirm, type ShareConfirmAction, shareErrorKey, useCopyLink } from './parts';
import { absoluteUrl, copyText, useItemShares, useShareMutations } from './queries';

export interface ShareTarget { id: string; name: string; type: 'folder' | 'file' }

type View =
  | { kind: 'list' }
  | { kind: 'form'; share?: ShareLinkWire }
  | { kind: 'created'; share: ShareLinkWire; rotated?: boolean };

/**
 * Share dialog for one item: lists its links, creates and edits them. With `editShare` it opens
 * straight into that link's settings and closes after saving (used by the shared-links page).
 */
export function ShareDialog({ open, onOpenChange, item, editShare, onClosed }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  item: ShareTarget;
  editShare?: ShareLinkWire;
  onClosed?(): void;
}) {
  const { t } = useTranslation();
  const links = useItemShares(item.id, open && !editShare);
  const [view, setView] = useState<View | null>(editShare ? { kind: 'form', share: editShare } : null);
  const [confirm, setConfirm] = useState<(ShareConfirmAction & { open: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);

  const list = links.data ?? [];
  // Until the user picks a view: the list if the item has links, otherwise the create form.
  // After revoking the last link the list would be empty: offer a new one instead.
  const auto: View | null = links.data ? (list.length ? { kind: 'list' } : { kind: 'form' }) : null;
  const current: View | null = !view || (view.kind === 'list' && links.data && !list.length) ? auto : view;
  const close = () => onOpenChange(false);
  const back = () => setView(list.length ? { kind: 'list' } : null);

  let body: ReactNode;
  if (!current) {
    body = links.isError
      ? <FormError>{t(shareErrorKey(links.error))}</FormError>
      : <div aria-hidden className="flex flex-col gap-2"><Skeleton className="h-14 w-full rounded-lg" /><Skeleton className="h-14 w-full rounded-lg" /></div>;
  } else if (current.kind === 'form') {
    body = (
      <ShareForm
        key={current.share?.id ?? 'new'}
        item={item}
        share={current.share}
        onBusy={setBusy}
        cancelLabel={editShare || !list.length ? t('common.cancel') : t('shares.dialog.back')}
        onCancel={editShare || !list.length ? close : back}
        onSaved={(saved, created) => {
          if (created) setView({ kind: 'created', share: saved });
          else if (editShare) { notify.success(t('shares.toast.updated')); close(); }
          else { notify.success(t('shares.toast.updated')); setView({ kind: 'list' }); }
        }}
      />
    );
  } else if (current.kind === 'created') {
    body = <CreatedLink share={current.share} rotated={current.rotated} onDone={close} onShowAll={() => setView({ kind: 'list' })} />;
  } else {
    body = (
      <LinkList
        links={list}
        onEdit={(share) => setView({ kind: 'form', share })}
        onConfirm={(a) => setConfirm({ ...a, open: true })}
        onCreate={() => setView({ kind: 'form' })}
        onDone={close}
      />
    );
  }

  const title = current?.kind === 'form' && current.share ? t('shares.dialog.editTitle') : t('shares.dialog.title', { name: item.name });
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
        <DialogContent
          className="gap-5 sm:max-w-lg"
          onCloseAutoFocus={(e) => { if (onClosed) { e.preventDefault(); onClosed(); } }}
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="flex min-w-0 items-center gap-2.5 text-lg font-semibold">
              <FileIcon item={{ ...item, mime: null }} className="size-5" />
              <span className="truncate">{title}</span>
            </DialogTitle>
            <DialogDescription>
              {current?.kind === 'form' && current.share
                ? t('shares.dialog.editDescription', { name: item.name })
                : item.type === 'folder' ? t('shares.dialog.folderDescription') : t('shares.dialog.fileDescription')}
            </DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
      <ShareConfirm
        action={confirm}
        open={!!confirm?.open}
        onOpenChange={(o) => { if (!o) setConfirm((c) => (c ? { ...c, open: false } : c)); }}
        onRotated={(share) => setView({ kind: 'created', share, rotated: true })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function LinkList({ links, onEdit, onConfirm, onCreate, onDone }: {
  links: ShareLinkWire[];
  onEdit(share: ShareLinkWire): void;
  onConfirm(a: ShareConfirmAction): void;
  onCreate(): void;
  onDone(): void;
}) {
  const { t, i18n } = useTranslation();
  const [copy, manualCopy] = useCopyLink();
  return (
    <>
      {manualCopy}
      <ul aria-label={t('shares.dialog.links')} className="-mx-1 flex max-h-[min(22rem,50dvh)] flex-col gap-1 overflow-y-auto px-1">
        {links.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
            <Link2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" title={absoluteUrl(s.url)}>
                {s.url ? displayUrl(s.url) : t('shares.errors.noUrlShort')}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
                <span>{t('shares.createdOn', { date: formatDay(s.createdAt, i18n.language) })}, {expiryText(s, t, i18n.language)}</span>
                <ShareBadges share={s} />
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={(e) => copy(s, e.currentTarget)} disabled={!s.url} aria-label={t('shares.copy')}>
              <Copy />
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('shares.linkActions')}><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => onEdit(s)}><PencilLine />{t('shares.edit')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onConfirm({ kind: 'rotate', share: s })}><RefreshCw />{t('shares.rotate.action')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onConfirm({ kind: 'revoke', share: s })}><Unlink />{t('shares.revoke.action')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" onClick={onCreate}><Plus />{t('shares.dialog.createAnother')}</Button>
        <Button onClick={onDone}>{t('shares.dialog.done')}</Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function CreatedLink({ share, rotated, onDone, onShowAll }: { share: ShareLinkWire; rotated?: boolean; onDone(): void; onShowAll(): void }) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const url = absoluteUrl(share.url);
  const copy = (trigger: HTMLElement) => {
    copyText(url, trigger).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
      // Nothing could be copied: hand the user the selected URL to copy by hand.
      () => { field.current?.focus(); field.current?.select(); notify.error(t('shares.errors.copyManual')); },
    );
  };
  return (
    <>
      <div className="rounded-xl bg-canvas p-4 ring-1 ring-border">
        <p className="text-sm font-medium text-foreground">{rotated ? t('shares.created.rotatedTitle') : t('shares.created.title')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{rotated ? t('shares.created.rotatedBody') : t('shares.created.body')}</p>
        <div className="mt-3 flex gap-2">
          <Input
            ref={field}
            readOnly
            value={url}
            aria-label={t('shares.created.urlLabel')}
            onFocus={(e) => e.currentTarget.select()}
            className="bg-background text-sm md:text-sm"
          />
          <Button onClick={(e) => copy(e.currentTarget)} autoFocus className="min-w-28" aria-live="polite">
            {copied ? <Check /> : <Copy />}
            {copied ? t('shares.copied') : t('shares.copy')}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span>{expiryText(share, t, i18n.language)}</span>
          <ShareBadges share={share} />
        </div>
      </div>
      <DialogFooter className="sm:justify-between">
        <Button variant="outline" onClick={onShowAll}>{t('shares.dialog.showAll')}</Button>
        <Button variant="outline" onClick={onDone}>{t('shares.dialog.done')}</Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

const EXPIRY_LABEL: Record<ExpiryChoice, string> = {
  none: 'shares.form.expiryNone', '1d': 'shares.form.expiry1d', '7d': 'shares.form.expiry7d', '30d': 'shares.form.expiry30d', custom: 'shares.form.expiryCustom',
};

function SettingRow({ id, label, hint, checked, onChange, disabled, children }: {
  id: string; label: string; hint: string; checked: boolean; onChange(v: boolean): void; disabled?: boolean; children?: ReactNode;
}) {
  return (
    <div className="py-3">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-foreground">{label}</label>
          <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-describedby={`${id}-hint`} className="mt-0.5" />
      </div>
      {children}
    </div>
  );
}

function ShareForm({ item, share, onSaved, onCancel, cancelLabel, onBusy }: {
  item: ShareTarget;
  share?: ShareLinkWire;
  onSaved(share: ShareLinkWire, created: boolean): void;
  onCancel(): void;
  cancelLabel: string;
  onBusy(busy: boolean): void;
}) {
  const { t, i18n } = useTranslation();
  const ids = useId();
  const m = useShareMutations();
  const [v, setV] = useState<ShareFormValues>(() => initialValues(share));
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const passwordField = useRef<HTMLInputElement>(null);

  const ctx: ShareFormContext = { existing: share, isFolder: item.type === 'folder', expiryTouched };
  const errors = validateShareForm(v, ctx);
  const shown = submitted ? errors : {};
  const set = (patch: Partial<ShareFormValues>) => { setV((cur) => ({ ...cur, ...patch })); setServerError(null); };
  const setExpiry = (patch: Partial<ShareFormValues>) => { set(patch); setExpiryTouched(true); };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(errors) || pending) return;
    setPending(true);
    onBusy(true);
    setServerError(null);
    try {
      const saved = share
        ? await m.update.mutateAsync({ id: share.id, patch: patchPayload(v, ctx) })
        : await m.create.mutateAsync(createPayload(item.id, v, ctx));
      onSaved(saved, !share);
    } catch (err) {
      setServerError(t(shareErrorKey(err)));
    } finally {
      setPending(false);
      onBusy(false);
    }
  }

  const pwId = `${ids}-pw`;
  const pwErrId = `${ids}-pw-error`;
  const expErrId = `${ids}-exp-error`;
  const today = toDateInput(new Date());
  const keepsPassword = !!share?.hasPassword;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col">
      <div className="divide-y border-y">
        <SettingRow
          id={`${ids}-pw-on`}
          label={t('shares.form.password')}
          hint={t('shares.form.passwordHint')}
          checked={v.passwordOn}
          onChange={(on) => { set({ passwordOn: on }); if (on) window.setTimeout(() => passwordField.current?.focus(), 0); }}
        >
          {v.passwordOn && (
            <div className="mt-3">
              <label htmlFor={pwId} className="sr-only">{t('shares.form.passwordLabel')}</label>
              <PasswordInput
                ref={passwordField}
                id={pwId}
                value={v.password}
                autoComplete="new-password"
                placeholder={keepsPassword ? t('shares.form.passwordKeep') : t('shares.form.passwordPlaceholder', { count: PASSWORD_MIN })}
                aria-invalid={shown.password ? true : undefined}
                aria-describedby={shown.password ? pwErrId : undefined}
                onChange={(e) => set({ password: e.target.value })}
              />
              {shown.password && (
                <p id={pwErrId} className="mt-1.5 text-xs text-destructive">
                  {t(`shares.form.errors.password_${shown.password}`, { count: PASSWORD_MIN })}
                </p>
              )}
            </div>
          )}
        </SettingRow>

        <fieldset className="py-3">
          <legend className="float-left w-full text-sm font-medium text-foreground">{t('shares.form.expiry')}</legend>
          <p className="clear-both mt-0.5 text-xs text-muted-foreground">
            {share?.expiresAt && !expiryTouched ? t('shares.form.expiryCurrent', { text: expiryText(share, t, i18n.language) }) : t('shares.form.expiryHint')}
          </p>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={v.expiry}
            onValueChange={(x) => { if (x) setExpiry({ expiry: x as ExpiryChoice }); }}
            aria-label={t('shares.form.expiry')}
            className="mt-2.5 flex w-full"
          >
            {EXPIRY_CHOICES.map((c) => (
              <ToggleGroupItem
                key={c}
                value={c}
                className="flex-1 px-2 text-xs text-muted-foreground data-[state=on]:bg-accent-soft data-[state=on]:text-foreground"
              >
                {t(EXPIRY_LABEL[c])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {v.expiry === 'custom' && (
            <div className="mt-2.5">
              <label htmlFor={`${ids}-date`} className="sr-only">{t('shares.form.expiryDate')}</label>
              <Input
                id={`${ids}-date`}
                type="date"
                min={today}
                value={v.customDate}
                aria-invalid={shown.expiry ? true : undefined}
                aria-describedby={shown.expiry ? expErrId : undefined}
                onChange={(e) => setExpiry({ customDate: e.target.value })}
                className="w-auto tabular-nums"
              />
            </div>
          )}
          {shown.expiry && <p id={expErrId} className="mt-1.5 text-xs text-destructive">{t(`shares.form.errors.expiry_${shown.expiry}`)}</p>}
        </fieldset>

        <SettingRow
          id={`${ids}-dl`}
          label={t('shares.form.allowDownload')}
          hint={item.type === 'folder' ? t('shares.form.allowDownloadFolderHint') : t('shares.form.allowDownloadHint')}
          checked={v.allowDownload}
          onChange={(x) => set({ allowDownload: x })}
        />
        {item.type === 'folder' && (
          <SettingRow
            id={`${ids}-ul`}
            label={t('shares.form.allowUpload')}
            hint={t('shares.form.allowUploadHint')}
            checked={v.allowUpload}
            onChange={(x) => set({ allowUpload: x })}
          />
        )}
      </div>
      <div className={cn(serverError && 'mt-4')}><FormError>{serverError}</FormError></div>
      <DialogFooter className="mt-5">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>{cancelLabel}</Button>
        <Button type="submit" disabled={pending}>
          {share
            ? (pending ? t('shares.form.saving') : t('shares.form.save'))
            : (pending ? t('shares.form.creating') : t('shares.form.create'))}
        </Button>
      </DialogFooter>
    </form>
  );
}
