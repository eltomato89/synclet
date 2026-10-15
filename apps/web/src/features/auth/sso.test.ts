import { describe, expect, it } from 'vitest';
import { appLoginPath, appRedirectUrl, oidcStartUrl, parseAppLoginParams, showPasswordForm, ssoErrorKey } from './sso';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const valid = { client_id: 'ios', redirect_uri: 'synclet://oauth', code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'xyz' };
const q = (o: Record<string, string>) => new URLSearchParams(o);

describe('parseAppLoginParams', () => {
  it('accepts a complete request', () => {
    expect(parseAppLoginParams(q({ ...valid, login_hint: 'anna' }))).toEqual({
      clientId: 'ios', redirectUri: 'synclet://oauth', codeChallenge: CHALLENGE, codeChallengeMethod: 'S256', state: 'xyz', loginHint: 'anna',
    });
  });

  it.each([
    ['client_id', { client_id: '' }],
    ['client_id too long', { client_id: 'x'.repeat(41) }],
    ['redirect_uri', { redirect_uri: '' }],
    ['code_challenge shape', { code_challenge: 'short' }],
    ['code_challenge chars', { code_challenge: `${CHALLENGE.slice(0, 42)}=` }],
    ['plain method', { code_challenge_method: 'plain' }],
    ['state', { state: '' }],
  ])('rejects a bad %s', (_name, patch) => {
    expect(parseAppLoginParams(q({ ...valid, ...patch }))).toBeNull();
  });

  it('rejects a missing code_challenge_method', () => {
    const { code_challenge_method: _m, ...rest } = valid;
    expect(parseAppLoginParams(q(rest))).toBeNull();
  });

  it('round-trips through appLoginPath (the SSO return path)', () => {
    const p = parseAppLoginParams(q({ ...valid, state: 'a b&c=d/é' }))!;
    const path = appLoginPath(p);
    expect(path.startsWith('/app-login?')).toBe(true);
    expect(parseAppLoginParams(new URLSearchParams(path.slice('/app-login?'.length)))).toEqual(p);
  });
});

describe('appRedirectUrl', () => {
  it('adds code and state, URL-encoded, to a custom-scheme redirect', () => {
    const url = appRedirectUrl({ id: 'ios', name: 'x', redirectUri: 'synclet://oauth' }, 'c/d+e', 'a b&c=d#e');
    expect(url).toBe('synclet://oauth?code=c%2Fd%2Be&state=a+b%26c%3Dd%23e');
    const back = new URL(url);
    expect(back.searchParams.get('code')).toBe('c/d+e');
    expect(back.searchParams.get('state')).toBe('a b&c=d#e');
  });

  it('works for loopback redirects', () => {
    expect(appRedirectUrl({ id: 'linux', name: 'x', redirectUri: 'http://127.0.0.1:53682/callback' }, 'abc', 's'))
      .toBe('http://127.0.0.1:53682/callback?code=abc&state=s');
  });
});

describe('login methods helpers', () => {
  const m = (password: boolean, oidc: boolean) => ({ password, oidc: { enabled: oidc, label: 'SSO' }, forwardAuth: false, emergency: false });

  it('shows the password form unless single sign-on replaces it', () => {
    expect(showPasswordForm(m(true, true), false)).toBe(true);
    expect(showPasswordForm(m(false, true), false)).toBe(false);
    expect(showPasswordForm(m(false, true), true)).toBe(true); // ?local=1
    expect(showPasswordForm(m(false, false), false)).toBe(true); // nothing else to offer
    expect(showPasswordForm(undefined, false)).toBe(true); // methods unavailable
  });

  it('builds the OIDC start URL with an encoded return path', () => {
    expect(oidcStartUrl('/files/a b?x=1&y=2')).toBe('/api/auth/oidc/start?return=%2Ffiles%2Fa%20b%3Fx%3D1%26y%3D2');
  });

  it('maps sso_error codes to messages, unknown ones to a generic one', () => {
    expect(ssoErrorKey(null)).toBeNull();
    expect(ssoErrorKey('sso_not_allowed')).toBe('sso.error.sso_not_allowed');
    expect(ssoErrorKey('<script>')).toBe('sso.error.server_error');
  });
});
