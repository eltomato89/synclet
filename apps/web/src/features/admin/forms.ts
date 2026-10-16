import type { SsoSettingsInput, SsoSettingsWire } from '@synclet/shared';
import { errorKey } from '@/features/files/errors';
import { validateName } from '@/features/files/names';
import { ApiError } from '@/lib/api';
import type { SpaceRole } from './types';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Mirrors the server's username rule closely enough to catch typos before the round trip.
const BAD_USERNAME = /[/\\:*?"<>|@\u0000-\u001f\u007f​-‏‪-‮⁠⁦-⁩﻿]/;

// ---------------------------------------------------------------------------------------------
// Users

export interface UserFormValues {
  displayName: string;
  username: string;
  email: string;
  password: string;
  role: 'admin' | 'user';
  adopt: boolean;
}
export type UserFormErrors = Partial<Record<'displayName' | 'username' | 'email' | 'password', string>>;

/**
 * Error keys (`admin.users.form.errors.*`). `create` requires a username and a password; when
 * editing the password is optional (empty keeps the current one).
 */
export function validateUserForm(v: UserFormValues, mode: 'create' | 'edit'): UserFormErrors {
  const e: UserFormErrors = {};
  const name = v.displayName.trim();
  if (!name) e.displayName = 'displayNameRequired';
  else if (name.length > 100) e.displayName = 'displayNameTooLong';
  if (mode === 'create') {
    const u = v.username;
    if (!u.trim()) e.username = v.adopt ? 'folderRequired' : 'usernameRequired';
    else if (u !== u.trim() || u.startsWith('.') || u === '..' || BAD_USERNAME.test(u) || u.length > 255) e.username = 'usernameInvalid';
  }
  if (v.email.trim() && !EMAIL.test(v.email.trim())) e.email = 'emailInvalid';
  if (mode === 'create' || v.password) {
    if (!v.password) e.password = 'passwordRequired';
    else if (v.password.length < PASSWORD_MIN) e.password = 'passwordTooShort';
    else if (v.password.length > PASSWORD_MAX) e.password = 'passwordTooLong';
  }
  return e;
}

export const hasErrors = (e: object) => Object.keys(e).length > 0;

const MESSAGES: Record<string, string> = {
  'last admin': 'lastAdmin',
  'cannot disable yourself': 'selfDisable',
  'cannot delete yourself': 'selfDelete',
  'email already in use': 'emailTaken',
  'username or email already in use': 'userTaken',
  'folder is already assigned to a user': 'folderTaken',
  'folder to adopt does not exist': 'folderMissing',
  'invalid username': 'usernameInvalid',
};

/** i18n key for a failed admin request (users, sessions, devices, shares). */
export function adminErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    const known = MESSAGES[err.message];
    if (known) return `admin.errors.${known}`;
    if (err.message.startsWith('data folder not writable')) return 'admin.errors.dataNotWritable';
    if (err.status === 409 || err.code === 'name_conflict') return 'admin.errors.nameTaken';
    if (err.code === 'invalid_request') return 'admin.errors.invalid';
  }
  return errorKey(err);
}

/** Which form field a server error belongs to (shown inline there); undefined = form-level. */
export function userErrorField(err: unknown): keyof UserFormErrors | 'role' | undefined {
  if (!(err instanceof ApiError)) return undefined;
  switch (MESSAGES[err.message]) {
    case 'emailTaken': return 'email';
    case 'usernameInvalid': case 'folderTaken': case 'folderMissing': return 'username';
    case 'lastAdmin': return 'role';
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// SSO

/**
 * Client secret is write-only: the server only says whether one is stored.
 * keep = send nothing, replace = send the new value, clear = send null.
 */
export type SecretMode = 'keep' | 'replace' | 'clear';

export interface SsoFormValues {
  passwordLoginForUsers: boolean;
  oidc: {
    enabled: boolean; issuer: string; clientId: string; scopes: string; buttonLabel: string;
    usernameClaim: string; groupsClaim: string; allowedGroups: string[]; adminGroups: string[]; linkByEmail: boolean;
  };
  secret: { mode: SecretMode; value: string };
  forwardAuth: SsoSettingsWire['forwardAuth'];
}

export function ssoFormFromWire(w: SsoSettingsWire): SsoFormValues {
  const o = w.oidc;
  return {
    passwordLoginForUsers: w.passwordLoginForUsers,
    oidc: {
      enabled: o.enabled, issuer: o.issuer ?? '', clientId: o.clientId ?? '', scopes: o.scopes, buttonLabel: o.buttonLabel,
      usernameClaim: o.usernameClaim, groupsClaim: o.groupsClaim, allowedGroups: [...o.allowedGroups], adminGroups: [...o.adminGroups],
      linkByEmail: o.linkByEmail,
    },
    // Without a stored secret the field is simply empty ("replace" with nothing = don't send).
    secret: { mode: o.hasClientSecret ? 'keep' : 'replace', value: '' },
    forwardAuth: { ...w.forwardAuth, trustedProxies: [...w.forwardAuth.trustedProxies], allowedGroups: [...w.forwardAuth.allowedGroups], adminGroups: [...w.forwardAuth.adminGroups] },
  };
}

export function ssoInput(v: SsoFormValues): SsoSettingsInput {
  const o = v.oidc;
  const oidc: NonNullable<SsoSettingsInput['oidc']> = {
    enabled: o.enabled, issuer: o.issuer.trim() || null, clientId: o.clientId.trim() || null, scopes: o.scopes.trim().replace(/\s+/g, ' '),
    buttonLabel: o.buttonLabel.trim(), usernameClaim: o.usernameClaim.trim(), groupsClaim: o.groupsClaim.trim(),
    allowedGroups: o.allowedGroups, adminGroups: o.adminGroups, linkByEmail: o.linkByEmail,
  };
  if (v.secret.mode === 'clear') oidc.clientSecret = null;
  else if (v.secret.mode === 'replace' && v.secret.value) oidc.clientSecret = v.secret.value;
  const f = v.forwardAuth;
  return {
    passwordLoginForUsers: v.passwordLoginForUsers,
    oidc,
    forwardAuth: {
      enabled: f.enabled, userHeader: f.userHeader.trim(), emailHeader: f.emailHeader.trim(), nameHeader: f.nameHeader.trim(),
      groupsHeader: f.groupsHeader.trim(), trustedProxies: f.trustedProxies, allowedGroups: f.allowedGroups, adminGroups: f.adminGroups,
    },
  };
}

export type SsoField =
  | 'oidc.issuer' | 'oidc.clientId' | 'oidc.clientSecret' | 'oidc.scopes' | 'oidc.buttonLabel' | 'oidc.usernameClaim'
  | 'oidc.groupsClaim' | 'oidc.allowedGroups' | 'oidc.adminGroups'
  | 'forwardAuth.userHeader' | 'forwardAuth.emailHeader' | 'forwardAuth.nameHeader' | 'forwardAuth.groupsHeader'
  | 'forwardAuth.trustedProxies' | 'forwardAuth.allowedGroups' | 'forwardAuth.adminGroups';
/** Field → full i18n key, or a server message / offending value shown as is (`{ raw }`). */
export type SsoError = string | { raw: string } | { key: string; values: Record<string, string> };
export type SsoErrors = Partial<Record<SsoField | 'form', SsoError>>;

const HEADER = /^[A-Za-z0-9-]+$/;
const CLAIM = /^\S+$/;
const IPV4_CIDR = /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/;

/** Loose CIDR check (the server has the final word): IPv4 with octets ≤ 255, or anything with a colon for IPv6. */
export function looksLikeCidr(s: string): boolean {
  const [addr, prefix, ...rest] = s.split('/');
  if (rest.length || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) return false;
  if (addr.includes(':')) return /^[0-9a-fA-F:.]+$/.test(addr) && (prefix === undefined || (+prefix >= 1 && +prefix <= 128));
  return IPV4_CIDR.test(s) && addr.split('.').every((o) => +o <= 255) && (prefix === undefined || (+prefix >= 1 && +prefix <= 32));
}

export function validateSso(v: SsoFormValues, ctx: { hasClientSecret: boolean; redirectUri: string }): SsoErrors {
  const e: SsoErrors = {};
  const o = v.oidc;
  const issuer = o.issuer.trim();
  if (issuer) {
    try {
      const u = new URL(issuer);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') e['oidc.issuer'] = 'issuerUrl';
    } catch { e['oidc.issuer'] = 'issuerUrl'; }
  }
  if (o.enabled) {
    if (!ctx.redirectUri) e.form = 'publicUrlMissing';
    if (!issuer) e['oidc.issuer'] = 'issuerRequired';
    if (!o.clientId.trim()) e['oidc.clientId'] = 'clientIdRequired';
  }
  if (v.secret.mode === 'replace' && ctx.hasClientSecret && !v.secret.value) e['oidc.clientSecret'] = 'secretRequired';
  const scopes = o.scopes.trim().split(/\s+/).filter(Boolean);
  if (!scopes.includes('openid')) e['oidc.scopes'] = 'scopesOpenid';
  if (!o.buttonLabel.trim()) e['oidc.buttonLabel'] = 'required';
  else if (o.buttonLabel.trim().length > 60) e['oidc.buttonLabel'] = 'tooLong';
  if (!CLAIM.test(o.usernameClaim.trim())) e['oidc.usernameClaim'] = 'claim';
  if (!CLAIM.test(o.groupsClaim.trim())) e['oidc.groupsClaim'] = 'claim';
  const f = v.forwardAuth;
  for (const k of ['userHeader', 'emailHeader', 'nameHeader', 'groupsHeader'] as const) {
    if (!HEADER.test(f[k].trim())) e[`forwardAuth.${k}`] = 'header';
  }
  const badCidr = f.trustedProxies.find((c) => !looksLikeCidr(c));
  if (badCidr) e['forwardAuth.trustedProxies'] = { key: 'admin.sso.errors.cidr', values: { value: badCidr } };
  else if (f.enabled && f.trustedProxies.length === 0) e['forwardAuth.trustedProxies'] = 'proxyRequired';
  for (const [k, val] of Object.entries(e)) {
    if (typeof val === 'string') e[k as keyof SsoErrors] = `admin.sso.errors.${val}`;
  }
  return e;
}

/** Puts a server validation error next to the field it is about. */
export function ssoServerErrors(err: unknown): SsoErrors {
  if (!(err instanceof ApiError) || err.code !== 'invalid_request') return { form: errorKey(err) };
  const m = err.message;
  // Zod: "oidc.issuer: message; forwardAuth.userHeader: message"
  const zod = m.split('; ').map((part) => /^((?:oidc|forwardAuth)\.[A-Za-z]+)(?:\.\d+)?: (.+)$/.exec(part));
  if (zod.every(Boolean)) {
    const out: SsoErrors = {};
    for (const z of zod) out[z![1] as SsoField] = { raw: z![2] };
    return out;
  }
  const key = (k: string) => `admin.sso.errors.${k}`;
  if (m === 'OIDC needs an issuer') return { 'oidc.issuer': key('issuerRequired') };
  if (m === 'OIDC needs a client id') return { 'oidc.clientId': key('clientIdRequired') };
  if (m.startsWith('issuer ') || m.startsWith('http issuers') || m.startsWith('OIDC discovery failed')) return { 'oidc.issuer': { raw: m } };
  if (m.startsWith('scopes ')) return { 'oidc.scopes': key('scopesOpenid') };
  const cidr = /^invalid trusted proxy CIDR: (.*)$/.exec(m);
  if (cidr) return { 'forwardAuth.trustedProxies': { key: key('cidr'), values: { value: cidr[1] } } };
  if (m.startsWith('forward-auth needs')) return { 'forwardAuth.trustedProxies': key('proxyRequired') };
  if (m.startsWith('OIDC needs SYNCLET_PUBLIC_URL')) return { form: key('publicUrlMissing') };
  return { form: { raw: m } };
}

// ---------------------------------------------------------------------------------------------
// Groups and spaces

/** Group and team folder names follow the file name rules (`admin.spaces.form.errors.*`). */
export function validateSpaceName(raw: string): 'required' | 'invalid' | null {
  const name = raw.trim();
  if (!name) return 'required';
  if (raw !== name && /[ .]$/.test(raw)) return 'invalid';
  return validateName(name) ? 'invalid' : null;
}

export interface MemberRow { kind: 'user' | 'group'; id: string; name: string; role: SpaceRole }
export const memberKey = (m: Pick<MemberRow, 'kind' | 'id'>) => `${m.kind}:${m.id}`;

export function addMember(rows: MemberRow[], row: MemberRow): MemberRow[] {
  return rows.some((r) => memberKey(r) === memberKey(row)) ? rows : [...rows, row];
}
export const removeMember = (rows: MemberRow[], key: string): MemberRow[] => rows.filter((r) => memberKey(r) !== key);
export const setMemberRole = (rows: MemberRow[], key: string, role: SpaceRole): MemberRow[] =>
  rows.map((r) => (memberKey(r) === key ? { ...r, role } : r));
