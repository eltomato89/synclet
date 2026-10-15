import type { CreateShareInput, ShareLinkWire } from '@synclet/shared';
import type { SharePatch } from './queries';

export const PASSWORD_MIN = 6;
export const EXPIRY_CHOICES = ['none', '1d', '7d', '30d', 'custom'] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

export interface ShareFormValues {
  passwordOn: boolean;
  /** Empty while editing a protected link means "keep the current password". */
  password: string;
  expiry: ExpiryChoice;
  /** `yyyy-mm-dd` from the date input; the link expires at the end of that local day. */
  customDate: string;
  allowDownload: boolean;
  allowUpload: boolean;
}

export interface ShareFormErrors {
  password?: 'required' | 'too_short';
  expiry?: 'required' | 'past';
}

/** What the form is for: a new link, or an existing one (whose current settings matter). */
export interface ShareFormContext {
  existing?: Pick<ShareLinkWire, 'hasPassword' | 'expiresAt' | 'allowDownload' | 'allowUpload'>;
  isFolder: boolean;
  /** Whether the expiry was changed; untouched expiries of existing links are left alone. */
  expiryTouched: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function initialValues(share?: Pick<ShareLinkWire, 'hasPassword' | 'expiresAt' | 'allowDownload' | 'allowUpload'>): ShareFormValues {
  if (!share) {
    return { passwordOn: false, password: '', expiry: 'none', customDate: '', allowDownload: true, allowUpload: false };
  }
  return {
    passwordOn: share.hasPassword,
    password: '',
    expiry: share.expiresAt ? 'custom' : 'none',
    customDate: share.expiresAt ? toDateInput(new Date(share.expiresAt)) : '',
    allowDownload: share.allowDownload,
    allowUpload: share.allowUpload,
  };
}

const PRESET_DAYS: Partial<Record<ExpiryChoice, number>> = { '1d': 1, '7d': 7, '30d': 30 };

/** Expiry the form describes, `null` for "never", `undefined` for an unparsable custom date. */
export function expiryDate(v: Pick<ShareFormValues, 'expiry' | 'customDate'>, now: number = Date.now()): Date | null | undefined {
  if (v.expiry === 'none') return null;
  const days = PRESET_DAYS[v.expiry];
  if (days) return new Date(now + days * 86_400_000);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.customDate);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return d.getMonth() === Number(m[2]) - 1 ? d : undefined;
}

export function validateShareForm(v: ShareFormValues, ctx: ShareFormContext, now: number = Date.now()): ShareFormErrors {
  const errors: ShareFormErrors = {};
  if (v.passwordOn) {
    const keepsCurrent = !!ctx.existing?.hasPassword && v.password === '';
    if (!keepsCurrent) {
      if (v.password === '') errors.password = 'required';
      else if (v.password.length < PASSWORD_MIN) errors.password = 'too_short';
    }
  }
  if (!ctx.existing || ctx.expiryTouched) {
    const d = expiryDate(v, now);
    if (d === undefined) errors.expiry = 'required';
    else if (d && d.getTime() <= now) errors.expiry = 'past';
  }
  return errors;
}

export const hasErrors = (e: ShareFormErrors) => Object.keys(e).length > 0;

/** Request body for a new link. Call only when `validateShareForm` returned no errors. */
export function createPayload(itemId: string, v: ShareFormValues, ctx: ShareFormContext, now: number = Date.now()): CreateShareInput {
  return {
    itemId,
    password: v.passwordOn ? v.password : null,
    expiresAt: expiryDate(v, now)?.toISOString() ?? null,
    allowDownload: v.allowDownload,
    ...(ctx.isFolder ? { allowUpload: v.allowUpload } : {}),
  };
}

/** Only the fields that change; an empty password on a protected link keeps the current one. */
export function patchPayload(v: ShareFormValues, ctx: ShareFormContext, now: number = Date.now()): SharePatch {
  const cur = ctx.existing;
  const patch: SharePatch = {};
  if (!v.passwordOn) { if (!cur || cur.hasPassword) patch.password = null; }
  else if (v.password !== '') patch.password = v.password;
  if (!cur || ctx.expiryTouched) patch.expiresAt = expiryDate(v, now)?.toISOString() ?? null;
  if (v.allowDownload !== cur?.allowDownload) patch.allowDownload = v.allowDownload;
  if (ctx.isFolder && v.allowUpload !== cur?.allowUpload) patch.allowUpload = v.allowUpload;
  return patch;
}
