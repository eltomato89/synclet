import type { SsoSettingsWire } from '@synclet/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  adminErrorKey, looksLikeCidr, ssoFormFromWire, ssoInput, ssoServerErrors, type UserFormValues, userErrorField, validateSso,
  validateUserForm,
} from './forms';

const user: UserFormValues = { displayName: 'Anna', username: 'anna', email: '', password: 'correct horse', role: 'user', adopt: false };

describe('validateUserForm', () => {
  it('accepts a complete new user', () => {
    expect(validateUserForm(user, 'create')).toEqual({});
  });

  it('requires name, username and a long enough password when creating', () => {
    expect(validateUserForm({ ...user, displayName: ' ', username: '', password: 'short' }, 'create')).toEqual({
      displayName: 'displayNameRequired', username: 'usernameRequired', password: 'passwordTooShort',
    });
    expect(validateUserForm({ ...user, password: '' }, 'create').password).toBe('passwordRequired');
  });

  it('asks for a folder instead of a username when adopting', () => {
    expect(validateUserForm({ ...user, username: '', adopt: true }, 'create').username).toBe('folderRequired');
  });

  it.each(['.hidden', 'a/b', 'a\\b', 'x@y', 'con:', ' anna', 'a‮b'])('rejects the folder-unsafe username %j', (username) => {
    expect(validateUserForm({ ...user, username }, 'create').username).toBe('usernameInvalid');
  });

  it('checks the email only when one is given', () => {
    expect(validateUserForm({ ...user, email: 'nope' }, 'create').email).toBe('emailInvalid');
    expect(validateUserForm({ ...user, email: 'anna@example.com' }, 'create').email).toBeUndefined();
  });

  it('keeps the password optional when editing and ignores the username', () => {
    expect(validateUserForm({ ...user, username: '', password: '' }, 'edit')).toEqual({});
    expect(validateUserForm({ ...user, password: 'short' }, 'edit').password).toBe('passwordTooShort');
  });
});

describe('admin errors', () => {
  const lastAdmin = new ApiError(409, 'conflict', 'last admin');

  it('maps the last-admin conflict and other known server messages', () => {
    expect(adminErrorKey(lastAdmin)).toBe('admin.errors.lastAdmin');
    expect(adminErrorKey(new ApiError(409, 'conflict', 'cannot delete yourself'))).toBe('admin.errors.selfDelete');
    expect(adminErrorKey(new ApiError(409, 'name_conflict', 'email already in use'))).toBe('admin.errors.emailTaken');
    expect(adminErrorKey(new ApiError(500, 'invalid_request', 'data folder not writable: EACCES'))).toBe('admin.errors.dataNotWritable');
    expect(adminErrorKey(new ApiError(400, 'invalid_request', 'email: Invalid email'))).toBe('admin.errors.invalid');
    expect(adminErrorKey(new ApiError(0, 'network', 'down'))).toBe('files.errors.network');
  });

  it('attaches field errors to their field', () => {
    expect(userErrorField(lastAdmin)).toBe('role');
    expect(userErrorField(new ApiError(409, 'name_conflict', 'email already in use'))).toBe('email');
    expect(userErrorField(new ApiError(409, 'name_conflict', 'folder is already assigned to a user'))).toBe('username');
    expect(userErrorField(new ApiError(409, 'name_conflict', 'username or email already in use'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

const wire: SsoSettingsWire = {
  passwordLoginForUsers: true,
  oidc: {
    enabled: false, issuer: 'https://idp.example.com', clientId: 'synclet', hasClientSecret: true, scopes: 'openid profile email',
    buttonLabel: 'Sign in with SSO', usernameClaim: 'preferred_username', groupsClaim: 'groups', allowedGroups: [], adminGroups: ['admins'],
    linkByEmail: false, redirectUri: 'https://files.example.com/api/auth/oidc/callback',
  },
  forwardAuth: {
    enabled: false, userHeader: 'Remote-User', emailHeader: 'Remote-Email', nameHeader: 'Remote-Name', groupsHeader: 'Remote-Groups',
    trustedProxies: [], allowedGroups: [], adminGroups: [],
  },
  emergency: false,
};
const ctx = { hasClientSecret: true, redirectUri: wire.oidc.redirectUri };

describe('client secret (write-only)', () => {
  it('never sends the secret unless it is replaced or removed', () => {
    const v = ssoFormFromWire(wire);
    expect(v.secret).toEqual({ mode: 'keep', value: '' });
    expect(ssoInput(v).oidc).not.toHaveProperty('clientSecret');
  });

  it('sends a replacement, and null to remove it', () => {
    const v = ssoFormFromWire(wire);
    expect(ssoInput({ ...v, secret: { mode: 'replace', value: 's3cret' } }).oidc?.clientSecret).toBe('s3cret');
    expect(ssoInput({ ...v, secret: { mode: 'clear', value: '' } }).oidc?.clientSecret).toBeNull();
  });

  it('requires a value when replacing a stored secret', () => {
    const v = ssoFormFromWire(wire);
    expect(validateSso({ ...v, secret: { mode: 'replace', value: '' } }, ctx)['oidc.clientSecret']).toBe('admin.sso.errors.secretRequired');
  });

  it('treats an empty field without a stored secret as "no secret"', () => {
    const v = ssoFormFromWire({ ...wire, oidc: { ...wire.oidc, hasClientSecret: false } });
    expect(v.secret.mode).toBe('replace');
    expect(validateSso(v, { ...ctx, hasClientSecret: false })).toEqual({});
    expect(ssoInput(v).oidc).not.toHaveProperty('clientSecret');
  });
});

describe('validateSso', () => {
  const v = ssoFormFromWire(wire);

  it('accepts the stored settings', () => {
    expect(validateSso(v, ctx)).toEqual({});
  });

  it('needs issuer, client id and a public URL to enable OIDC', () => {
    const e = validateSso({ ...v, oidc: { ...v.oidc, enabled: true, issuer: '', clientId: ' ' } }, { ...ctx, redirectUri: '' });
    expect(e).toMatchObject({
      form: 'admin.sso.errors.publicUrlMissing', 'oidc.issuer': 'admin.sso.errors.issuerRequired', 'oidc.clientId': 'admin.sso.errors.clientIdRequired',
    });
  });

  it('checks the issuer URL, scopes, claims and headers', () => {
    const e = validateSso({
      ...v,
      oidc: { ...v.oidc, issuer: 'idp.example.com', scopes: 'profile email', usernameClaim: 'user name' },
      forwardAuth: { ...v.forwardAuth, userHeader: 'Remote User' },
    }, ctx);
    expect(e).toMatchObject({
      'oidc.issuer': 'admin.sso.errors.issuerUrl', 'oidc.scopes': 'admin.sso.errors.scopesOpenid',
      'oidc.usernameClaim': 'admin.sso.errors.claim', 'forwardAuth.userHeader': 'admin.sso.errors.header',
    });
  });

  it('needs a trusted proxy for forward-auth and flags the bad CIDR', () => {
    expect(validateSso({ ...v, forwardAuth: { ...v.forwardAuth, enabled: true } }, ctx)['forwardAuth.trustedProxies']).toBe('admin.sso.errors.proxyRequired');
    expect(validateSso({ ...v, forwardAuth: { ...v.forwardAuth, trustedProxies: ['10.0.0.0/8', '300.1.1.1'] } }, ctx)['forwardAuth.trustedProxies'])
      .toEqual({ key: 'admin.sso.errors.cidr', values: { value: '300.1.1.1' } });
  });

  it.each([['10.0.0.0/8', true], ['192.168.1.5', true], ['fd00::/8', true], ['::1', true], ['10.0.0.0/33', false], ['nas.local', false], ['1.2.3', false]])(
    'looksLikeCidr(%s) = %s', (s, ok) => { expect(looksLikeCidr(s as string)).toBe(ok); },
  );
});

describe('ssoServerErrors', () => {
  const bad = (m: string) => ssoServerErrors(new ApiError(400, 'invalid_request', m));

  it('maps server validation messages to their fields', () => {
    expect(bad('OIDC discovery failed: fetch failed')).toEqual({ 'oidc.issuer': { raw: 'OIDC discovery failed: fetch failed' } });
    expect(bad('issuer must be an https URL')).toEqual({ 'oidc.issuer': { raw: 'issuer must be an https URL' } });
    expect(bad('OIDC needs a client id')).toEqual({ 'oidc.clientId': 'admin.sso.errors.clientIdRequired' });
    expect(bad('scopes must be space-separated and include "openid"')).toEqual({ 'oidc.scopes': 'admin.sso.errors.scopesOpenid' });
    expect(bad('invalid trusted proxy CIDR: 1::2::3')).toEqual({ 'forwardAuth.trustedProxies': { key: 'admin.sso.errors.cidr', values: { value: '1::2::3' } } });
    expect(bad('forward-auth needs at least one trusted proxy CIDR')).toEqual({ 'forwardAuth.trustedProxies': 'admin.sso.errors.proxyRequired' });
    expect(bad('OIDC needs SYNCLET_PUBLIC_URL (redirect URI)')).toEqual({ form: 'admin.sso.errors.publicUrlMissing' });
  });

  it('splits zod messages per field', () => {
    expect(bad('forwardAuth.userHeader: header names may only contain letters, digits and "-"; oidc.adminGroups.0: too long')).toEqual({
      'forwardAuth.userHeader': { raw: 'header names may only contain letters, digits and "-"' },
      'oidc.adminGroups': { raw: 'too long' },
    });
  });

  it('keeps unknown messages and transport errors form-level', () => {
    expect(bad('something else')).toEqual({ form: { raw: 'something else' } });
    expect(ssoServerErrors(new ApiError(0, 'network', 'x'))).toEqual({ form: 'files.errors.network' });
  });
});
