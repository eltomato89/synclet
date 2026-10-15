import type { SsoSettingsWire } from '@synclet/shared';
import { Check, CircleCheck, CircleX, Copy, KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTopbar } from '@/components/app-shell/Topbar';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { StatusMessage } from '@/features/files/EmptyState';
import { copyText } from '@/features/shares/queries';
import { cn } from '@/lib/utils';
import { useAdminTitle } from './AdminLayout';
import {
  adminErrorKey, hasErrors, type SsoErrors, type SsoField, type SsoFormValues, ssoFormFromWire, ssoInput, ssoServerErrors, validateSso,
} from './forms';
import { FieldError, notify, Section, TagInput } from './parts';
import { type SsoTestResult, useSsoMutations, useSsoSettings } from './queries';

export const RESET_ADMIN_COMMAND = 'docker compose exec server node dist/cli/reset-admin-password.js <username>';

/** Sign-in settings: password login for users, OpenID Connect and the auth proxy (forward-auth). */
export function SsoPage() {
  const { t } = useTranslation();
  const settings = useSsoSettings();
  const [generation, setGeneration] = useState(0);
  useAdminTitle(t('admin.nav.sso'));
  useTopbar(<h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('admin.sso.title')}</h1>);

  if (!settings.data && settings.error) {
    return (
      <StatusMessage title={t('admin.sso.loadError')} body={t(adminErrorKey(settings.error))}>
        <Button variant="outline" onClick={() => void settings.refetch()} disabled={settings.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  }
  if (!settings.data) {
    return (
      <div aria-hidden className="mx-auto max-w-3xl px-4 py-6 md:px-6">
        <Skeleton className="h-20 w-full rounded-xl" /><Skeleton className="mt-8 h-96 w-full rounded-xl" />
      </div>
    );
  }
  // A fresh form after every save, so the write-only secret field starts over.
  return <SsoForm key={generation} wire={settings.data} onSaved={() => setGeneration((g) => g + 1)} />;
}

export function SsoForm({ wire, onSaved }: { wire: SsoSettingsWire; onSaved(): void }) {
  const { t } = useTranslation();
  const ids = useId();
  const m = useSsoMutations();
  const [v, setV] = useState<SsoFormValues>(() => ssoFormFromWire(wire));
  const [submitted, setSubmitted] = useState(false);
  const [server, setServer] = useState<SsoErrors>({});
  const [test, setTest] = useState<SsoTestResult | { failed: string } | null>(null);

  const ctx = { hasClientSecret: wire.oidc.hasClientSecret, redirectUri: wire.oidc.redirectUri };
  const local = validateSso(v, ctx);
  const errors: SsoErrors = { ...(submitted ? local : {}), ...server };
  const initial = JSON.stringify(ssoInput(ssoFormFromWire(wire)));
  const dirty = JSON.stringify(ssoInput(v)) !== initial;

  const setOidc = (patch: Partial<SsoFormValues['oidc']>) => { setV((c) => ({ ...c, oidc: { ...c.oidc, ...patch } })); clear(Object.keys(patch).map((k) => `oidc.${k}`)); };
  const setFa = (patch: Partial<SsoFormValues['forwardAuth']>) => { setV((c) => ({ ...c, forwardAuth: { ...c.forwardAuth, ...patch } })); clear(Object.keys(patch).map((k) => `forwardAuth.${k}`)); };
  const setSecret = (patch: Partial<SsoFormValues['secret']>) => { setV((c) => ({ ...c, secret: { ...c.secret, ...patch } })); clear(['oidc.clientSecret']); };
  function clear(fields: string[]) {
    setServer((s) => {
      const next = { ...s };
      for (const f of [...fields, 'form']) delete next[f as SsoField];
      return next;
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServer({});
    if (hasErrors(local) || m.save.isPending) {
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    try {
      await m.save.mutateAsync(ssoInput(v));
      notify.success(t('admin.sso.saved'));
      onSaved();
    } catch (err) {
      setServer(ssoServerErrors(err));
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
    }
  }

  async function runTest() {
    setTest(null);
    try {
      setTest(await m.test.mutateAsync(v.oidc.issuer));
    } catch (err) {
      setTest({ failed: t(adminErrorKey(err)) });
    }
  }

  const id = (f: string) => `${ids}-${f.replace('.', '-')}`;
  const field = (name: SsoField) => ({
    id: id(name),
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? `${id(name)}-error` : `${id(name)}-hint`,
  });
  const formError = errors.form;

  return (
    <form onSubmit={onSubmit} noValidate className="mx-auto max-w-3xl px-4 pt-6 md:px-6">
      {wire.emergency && <EmergencyBanner />}

      <Section id="password" title={t('admin.sso.password.title')} description={t('admin.sso.password.hint')}>
        <Toggle
          id={id('pw')}
          label={t('admin.sso.password.forUsers')}
          hint={t('admin.sso.password.forUsersHint')}
          checked={v.passwordLoginForUsers}
          onChange={(x) => setV((c) => ({ ...c, passwordLoginForUsers: x }))}
        />
      </Section>

      <Section id="oidc" title={t('admin.sso.oidc.title')} description={t('admin.sso.oidc.hint')} className="border-t">
        <div className="flex flex-col gap-5">
          <Toggle
            id={id('oidc-on')}
            label={t('admin.sso.oidc.enabled')}
            hint={wire.oidc.redirectUri ? t('admin.sso.oidc.enabledHint') : t('admin.sso.oidc.noPublicUrl')}
            checked={v.oidc.enabled}
            onChange={(x) => setOidc({ enabled: x })}
          />
          <RedirectUri uri={wire.oidc.redirectUri} />

          <Row>
            <Field label={t('admin.sso.oidc.issuer')} name="oidc.issuer" hint={t('admin.sso.oidc.issuerHint')} error={errors['oidc.issuer']} fieldId={id('oidc.issuer')} wide>
              <div className="flex gap-2">
                <Input {...field('oidc.issuer')} value={v.oidc.issuer} placeholder="https://auth.example.com/application/o/synclet/" spellCheck={false}
                  onChange={(e) => { setOidc({ issuer: e.target.value }); setTest(null); }}
                />
                <Button type="button" variant="outline" onClick={() => void runTest()} disabled={m.test.isPending || (!v.oidc.issuer.trim() && !wire.oidc.issuer)} className="shrink-0">
                  {m.test.isPending ? t('admin.sso.oidc.testing') : t('admin.sso.oidc.test')}
                </Button>
              </div>
              <TestResult result={test} />
            </Field>
          </Row>
          <Row>
            <Field label={t('admin.sso.oidc.clientId')} name="oidc.clientId" error={errors['oidc.clientId']} fieldId={id('oidc.clientId')}>
              <Input {...field('oidc.clientId')} value={v.oidc.clientId} spellCheck={false} autoComplete="off" onChange={(e) => setOidc({ clientId: e.target.value })} />
            </Field>
            <SecretField
              fieldProps={field('oidc.clientSecret')}
              hasSecret={wire.oidc.hasClientSecret}
              value={v.secret}
              onChange={setSecret}
              error={errors['oidc.clientSecret']}
            />
          </Row>
          <Row>
            <Field label={t('admin.sso.oidc.scopes')} name="oidc.scopes" hint={t('admin.sso.oidc.scopesHint')} error={errors['oidc.scopes']} fieldId={id('oidc.scopes')}>
              <Input {...field('oidc.scopes')} value={v.oidc.scopes} spellCheck={false} onChange={(e) => setOidc({ scopes: e.target.value })} />
            </Field>
            <Field label={t('admin.sso.oidc.buttonLabel')} name="oidc.buttonLabel" hint={t('admin.sso.oidc.buttonLabelHint')} error={errors['oidc.buttonLabel']} fieldId={id('oidc.buttonLabel')}>
              <Input {...field('oidc.buttonLabel')} value={v.oidc.buttonLabel} maxLength={60} onChange={(e) => setOidc({ buttonLabel: e.target.value })} />
            </Field>
          </Row>
          <Row>
            <Field label={t('admin.sso.oidc.usernameClaim')} name="oidc.usernameClaim" hint={t('admin.sso.oidc.usernameClaimHint')} error={errors['oidc.usernameClaim']} fieldId={id('oidc.usernameClaim')}>
              <Input {...field('oidc.usernameClaim')} value={v.oidc.usernameClaim} spellCheck={false} onChange={(e) => setOidc({ usernameClaim: e.target.value })} />
            </Field>
            <Field label={t('admin.sso.oidc.groupsClaim')} name="oidc.groupsClaim" hint={t('admin.sso.oidc.groupsClaimHint')} error={errors['oidc.groupsClaim']} fieldId={id('oidc.groupsClaim')}>
              <Input {...field('oidc.groupsClaim')} value={v.oidc.groupsClaim} spellCheck={false} onChange={(e) => setOidc({ groupsClaim: e.target.value })} />
            </Field>
          </Row>
          <GroupFields
            prefix="oidc"
            idOf={id}
            allowed={v.oidc.allowedGroups}
            admin={v.oidc.adminGroups}
            errors={errors}
            onChange={(patch) => setOidc(patch)}
          />
          <div>
            <Toggle
              id={id('link')}
              label={t('admin.sso.oidc.linkByEmail')}
              hint={t('admin.sso.oidc.linkByEmailHint')}
              checked={v.oidc.linkByEmail}
              onChange={(x) => setOidc({ linkByEmail: x })}
            />
            {v.oidc.linkByEmail && (
              <Callout tone="warn" icon={<TriangleAlert />} className="mt-3">{t('admin.sso.oidc.linkByEmailWarning')}</Callout>
            )}
          </div>
        </div>
      </Section>

      <Section id="forward" title={t('admin.sso.forward.title')} description={t('admin.sso.forward.hint')} className="border-t">
        <div className="flex flex-col gap-5">
          <Callout tone="danger" icon={<ShieldAlert />} title={t('admin.sso.forward.warningTitle')}>
            {t('admin.sso.forward.warning')}
          </Callout>
          <Toggle
            id={id('fa-on')}
            label={t('admin.sso.forward.enabled')}
            hint={t('admin.sso.forward.enabledHint')}
            checked={v.forwardAuth.enabled}
            onChange={(x) => setFa({ enabled: x })}
          />
          <Field label={t('admin.sso.forward.trustedProxies')} name="forwardAuth.trustedProxies" hint={t('admin.sso.forward.trustedProxiesHint')} error={errors['forwardAuth.trustedProxies']} fieldId={id('forwardAuth.trustedProxies')} wide>
            <TagInput
              id={id('forwardAuth.trustedProxies')}
              value={v.forwardAuth.trustedProxies}
              onChange={(trustedProxies) => setFa({ trustedProxies })}
              placeholder="172.30.0.10/32"
              splitOnSpace
              invalid={!!errors['forwardAuth.trustedProxies']}
              describedBy={errors['forwardAuth.trustedProxies'] ? `${id('forwardAuth.trustedProxies')}-error` : `${id('forwardAuth.trustedProxies')}-hint`}
            />
          </Field>
          <Row>
            {(['userHeader', 'emailHeader', 'nameHeader', 'groupsHeader'] as const).map((h) => (
              <Field key={h} label={t(`admin.sso.forward.${h}`)} name={`forwardAuth.${h}`} error={errors[`forwardAuth.${h}`]} fieldId={id(`forwardAuth.${h}`)}>
                <Input {...field(`forwardAuth.${h}`)} value={v.forwardAuth[h]} spellCheck={false} onChange={(e) => setFa({ [h]: e.target.value })} />
              </Field>
            ))}
          </Row>
          <GroupFields
            prefix="forwardAuth"
            idOf={id}
            allowed={v.forwardAuth.allowedGroups}
            admin={v.forwardAuth.adminGroups}
            errors={errors}
            onChange={(patch) => setFa(patch)}
          />
        </div>
      </Section>

      <Section id="lockout" title={t('admin.sso.lockout.title')} className="border-t">
        <LockoutHelp />
      </Section>

      <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:-mx-6 md:px-6">
        {formError && <div className="mb-3"><FormError>{typeof formError === 'string' ? t(formError) : 'raw' in formError ? formError.raw : t(formError.key, formError.values)}</FormError></div>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{dirty ? t('admin.sso.unsaved') : t('admin.sso.upToDate')}</span>
          <Button type="button" variant="outline" disabled={!dirty || m.save.isPending}
            onClick={() => { setV(ssoFormFromWire(wire)); setServer({}); setSubmitted(false); setTest(null); }}
          >
            {t('admin.sso.discard')}
          </Button>
          <Button type="submit" disabled={!dirty || m.save.isPending}>{m.save.isPending ? t('admin.sso.saving') : t('admin.sso.save')}</Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2">{children}</div>;
}

function Field({ label, name, hint, error, fieldId, wide, children }: {
  label: string; name: string; hint?: string; error: SsoErrors[SsoField]; fieldId: string; wide?: boolean; children: ReactNode;
}) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')} data-field={name}>
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      {children}
      {error ? <FieldError id={`${fieldId}-error`} error={error} /> : hint ? <p id={`${fieldId}-hint`} className="mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block cursor-pointer text-sm font-medium text-foreground">{label}</label>
        <p id={`${id}-hint`} className="mt-0.5 max-w-[60ch] text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={`${id}-hint`} className="mt-0.5" />
    </div>
  );
}

function Callout({ tone, icon, title, children, className }: { tone: 'warn' | 'danger'; icon: ReactNode; title?: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        'flex gap-3 rounded-lg border px-3.5 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0',
        tone === 'danger' ? 'border-destructive/30 bg-destructive/6 [&>svg]:text-destructive' : 'border-chart-4/40 bg-chart-4/10 [&>svg]:text-chart-4',
        className,
      )}
    >
      {icon}
      <div className="min-w-0">
        {title && <p className="font-medium text-foreground">{title}</p>}
        <p className={cn('text-foreground/85', title && 'mt-0.5')}>{children}</p>
      </div>
    </div>
  );
}

function EmergencyBanner() {
  const { t } = useTranslation();
  return (
    <div role="alert" className="mb-8 rounded-xl border border-destructive/40 bg-destructive/8 p-4">
      <div className="flex items-center gap-2 text-destructive">
        <ShieldAlert className="size-4.5 shrink-0" />
        <p className="text-base font-semibold">{t('admin.sso.emergency.title')}</p>
      </div>
      <p className="mt-1.5 text-sm text-foreground/85">{t('admin.sso.emergency.body')}</p>
    </div>
  );
}

function LockoutHelp() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 text-sm text-muted-foreground">
      <p className="max-w-[68ch]">{t('admin.sso.lockout.emergency')}</p>
      <pre className="overflow-x-auto rounded-lg bg-muted px-3.5 py-2.5 text-xs text-foreground"><code>SYNCLET_SSO_EMERGENCY=1</code></pre>
      <p className="max-w-[68ch]">{t('admin.sso.lockout.reset')}</p>
      <pre className="overflow-x-auto rounded-lg bg-muted px-3.5 py-2.5 text-xs text-foreground"><code>{RESET_ADMIN_COMMAND}</code></pre>
      <p className="max-w-[68ch]">{t('admin.sso.lockout.local')}</p>
    </div>
  );
}

function RedirectUri({ uri }: { uri: string }) {
  const { t } = useTranslation();
  const ids = useId();
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  if (!uri) {
    return <Callout tone="warn" icon={<TriangleAlert />}>{t('admin.sso.oidc.redirectMissing')}</Callout>;
  }
  const copy = (trigger: HTMLElement) => {
    copyText(uri, trigger).then(
      () => { setCopied(true); notify.success(t('admin.sso.oidc.redirectCopied')); window.setTimeout(() => setCopied(false), 1600); },
      () => { field.current?.focus(); field.current?.select(); notify.error(t('admin.sso.oidc.redirectCopyManual')); },
    );
  };
  return (
    <div className="rounded-lg bg-canvas p-3.5 ring-1 ring-border">
      <label htmlFor={ids} className="block text-sm font-medium text-foreground">{t('admin.sso.oidc.redirectUri')}</label>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('admin.sso.oidc.redirectHint')}</p>
      <div className="mt-2.5 flex gap-2">
        <Input ref={field} id={ids} readOnly value={uri} onFocus={(e) => e.currentTarget.select()} className="bg-background text-sm md:text-sm" />
        <Button type="button" variant="outline" onClick={(e) => copy(e.currentTarget)} className="shrink-0" aria-label={t('admin.sso.oidc.copyRedirect')}>
          {copied ? <Check /> : <Copy />}
          <span className="max-sm:sr-only">{copied ? t('admin.sso.oidc.copied') : t('admin.sso.oidc.copy')}</span>
        </Button>
      </div>
    </div>
  );
}

function TestResult({ result }: { result: SsoTestResult | { failed: string } | null }) {
  const { t } = useTranslation();
  if (!result) return null;
  const ok = 'ok' in result && result.ok;
  const message = 'failed' in result ? result.failed : result.ok ? t('admin.sso.oidc.testOk', { issuer: result.issuer ?? '' }) : t('admin.sso.oidc.testFailed', { error: result.error ?? '' });
  return (
    <p role="status" className={cn('mt-2 flex items-start gap-1.5 text-xs break-words', ok ? 'text-primary' : 'text-destructive')}>
      {ok ? <CircleCheck className="mt-px size-3.5 shrink-0" /> : <CircleX className="mt-px size-3.5 shrink-0" />}
      <span className="min-w-0">{message}</span>
    </p>
  );
}

/**
 * Write-only client secret. A stored secret is never sent back: the field shows that one is set
 * and offers to replace or remove it; leaving it alone keeps it.
 */
export function SecretField({ fieldProps, hasSecret, value, onChange, error }: {
  fieldProps: { id: string; 'aria-invalid'?: boolean; 'aria-describedby': string };
  hasSecret: boolean;
  value: SsoFormValues['secret'];
  onChange(patch: Partial<SsoFormValues['secret']>): void;
  error: SsoErrors[SsoField];
}) {
  const { t } = useTranslation();
  const id = fieldProps.id;
  let control: ReactNode;
  let hint: string;
  if (hasSecret && value.mode === 'keep') {
    control = (
      <div className="flex h-9 items-center gap-2">
        <span className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-accent-soft px-2.5 text-sm font-medium text-foreground">
          <KeyRound className="size-3.5 shrink-0 text-primary" aria-hidden />{t('admin.sso.oidc.secretSet')}
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ mode: 'replace', value: '' })}>
          {t('admin.sso.oidc.secretReplace')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ mode: 'clear' })} className="text-muted-foreground hover:text-destructive">
          {t('admin.sso.oidc.secretRemove')}
        </Button>
      </div>
    );
    hint = t('admin.sso.oidc.secretKeepHint');
  } else if (hasSecret && value.mode === 'clear') {
    control = (
      <div className="flex h-9 items-center gap-2">
        <span className="text-sm text-destructive">{t('admin.sso.oidc.secretWillRemove')}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ mode: 'keep' })}>{t('admin.sso.oidc.secretUndo')}</Button>
      </div>
    );
    hint = t('admin.sso.oidc.secretRemoveHint');
  } else {
    control = (
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <PasswordInput
            {...fieldProps}
            value={value.value}
            autoComplete="new-password"
            autoFocus={hasSecret}
            placeholder={hasSecret ? t('admin.sso.oidc.secretNewPlaceholder') : t('admin.sso.oidc.secretPlaceholder')}
            onChange={(e) => onChange({ value: e.target.value })}
          />
        </div>
        {hasSecret && (
          <Button type="button" variant="ghost" onClick={() => onChange({ mode: 'keep', value: '' })} className="shrink-0">{t('common.cancel')}</Button>
        )}
      </div>
    );
    hint = hasSecret ? t('admin.sso.oidc.secretReplaceHint') : t('admin.sso.oidc.secretHint');
  }
  const editing = !hasSecret || value.mode === 'replace';
  const labelCls = 'mb-1.5 block text-sm font-medium text-foreground';
  return (
    // Without the input (secret kept or to be removed) the label names the group of buttons instead.
    <div className="min-w-0" data-field="oidc.clientSecret" role={editing ? undefined : 'group'} aria-labelledby={editing ? undefined : `${id}-label`}>
      {editing
        ? <label htmlFor={id} className={labelCls}>{t('admin.sso.oidc.clientSecret')}</label>
        : <span id={`${id}-label`} className={labelCls}>{t('admin.sso.oidc.clientSecret')}</span>}
      {control}
      {error ? <FieldError id={`${id}-error`} error={error} /> : <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function GroupFields({ prefix, idOf, allowed, admin, errors, onChange }: {
  prefix: 'oidc' | 'forwardAuth';
  idOf(f: string): string;
  allowed: string[];
  admin: string[];
  errors: SsoErrors;
  onChange(patch: { allowedGroups?: string[]; adminGroups?: string[] }): void;
}) {
  const { t } = useTranslation();
  const a = `${prefix}.allowedGroups` as const;
  const ad = `${prefix}.adminGroups` as const;
  return (
    <Row>
      <Field label={t('admin.sso.groups.allowed')} name={a} hint={t('admin.sso.groups.allowedHint')} error={errors[a]} fieldId={idOf(a)}>
        <TagInput id={idOf(a)} value={allowed} onChange={(allowedGroups) => onChange({ allowedGroups })} placeholder={t('admin.sso.groups.placeholder')}
          invalid={!!errors[a]} describedBy={errors[a] ? `${idOf(a)}-error` : `${idOf(a)}-hint`}
        />
      </Field>
      <Field label={t('admin.sso.groups.admin')} name={ad} hint={t('admin.sso.groups.adminHint')} error={errors[ad]} fieldId={idOf(ad)}>
        <TagInput id={idOf(ad)} value={admin} onChange={(adminGroups) => onChange({ adminGroups })} placeholder={t('admin.sso.groups.placeholder')}
          invalid={!!errors[ad]} describedBy={errors[ad] ? `${idOf(ad)}-error` : `${idOf(ad)}-hint`}
        />
      </Field>
    </Row>
  );
}
