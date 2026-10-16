import type { SsoSettingsWire } from '@synclet/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { ApiError } from '@/lib/api';
import i18n from '@/lib/i18n';
import { testQueryClient } from '@/test/query';
import { SsoForm } from './SsoPage';

const wire: SsoSettingsWire = {
  passwordLoginForUsers: true,
  oidc: {
    enabled: true, issuer: 'https://idp.example.com', clientId: 'synclet', hasClientSecret: true, scopes: 'openid profile email',
    buttonLabel: 'Sign in with SSO', usernameClaim: 'preferred_username', groupsClaim: 'groups', allowedGroups: [], adminGroups: ['admins'],
    linkByEmail: false, redirectUri: 'https://files.example.com/api/auth/oidc/callback',
  },
  forwardAuth: {
    enabled: false, userHeader: 'Remote-User', emailHeader: 'Remote-Email', nameHeader: 'Remote-Name', groupsHeader: 'Remote-Groups',
    trustedProxies: [], allowedGroups: [], adminGroups: [],
  },
  emergency: false,
};

let puts: unknown[] = [];
let putError: unknown = null;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  puts = [];
  putError = null;
  vi.spyOn(apiMod, 'api').mockImplementation(async (path, init) => {
    const i = init as RequestInit & { json?: unknown };
    if (path === '/admin/sso' && i?.method === 'PUT') {
      puts.push(i.json);
      if (putError) throw putError;
      return wire;
    }
    if (path === '/admin/sso/test') return { ok: false, error: 'getaddrinfo ENOTFOUND idp.example.com' };
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderForm(w: SsoSettingsWire = wire, onSaved = vi.fn()) {
  const { wrapper: Wrapper } = testQueryClient();
  render(<Wrapper><SsoForm wire={w} onSaved={onSaved} /></Wrapper>);
  return onSaved;
}

const save = () => screen.getByRole('button', { name: 'Save changes' });

it('shows a stored client secret only as "Set" and never fills it in', () => {
  renderForm();
  expect(screen.getByText('Set')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('New client secret')).toBeNull();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(save()).toBeDisabled(); // nothing changed
});

it('sends the secret only when it is replaced', async () => {
  const onSaved = renderForm();
  fireEvent.change(screen.getByLabelText('Button label'), { target: { value: 'Company login' } });
  fireEvent.click(save());
  await waitFor(() => expect(puts).toHaveLength(1));
  expect((puts[0] as { oidc: object }).oidc).not.toHaveProperty('clientSecret');
  expect((puts[0] as { oidc: { buttonLabel: string } }).oidc.buttonLabel).toBe('Company login');
  await waitFor(() => expect(onSaved).toHaveBeenCalled());

  cleanup();
  renderForm();
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  // Replacing with nothing is caught before sending.
  fireEvent.click(save());
  expect(save()).toBeDisabled(); // still nothing to send
  fireEvent.change(screen.getByPlaceholderText('New client secret'), { target: { value: 'n3w-s3cret' } });
  fireEvent.click(save());
  await waitFor(() => expect(puts).toHaveLength(2));
  expect((puts[1] as { oidc: { clientSecret: string } }).oidc.clientSecret).toBe('n3w-s3cret');
});

it('sends null to remove the secret, and can undo before saving', async () => {
  renderForm();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(screen.getByText('Will be removed on save')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Keep secret' }));
  expect(screen.getByText('Set')).toBeInTheDocument();
  expect(save()).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  fireEvent.click(save());
  await waitFor(() => expect(puts).toHaveLength(1));
  expect((puts[0] as { oidc: { clientSecret: null } }).oidc.clientSecret).toBeNull();
});

it('shows local validation errors inline and does not send', () => {
  renderForm();
  fireEvent.change(screen.getByLabelText('Scopes'), { target: { value: 'profile email' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Sign in through the auth proxy' }));
  fireEvent.click(save());
  expect(screen.getByText('The scopes must include openid.')).toBeInTheDocument();
  expect(screen.getByLabelText('Scopes')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Add at least one trusted proxy address before turning on the auth proxy.')).toBeInTheDocument();
  expect(puts).toHaveLength(0);
});

it('maps server validation errors to their field', async () => {
  putError = new ApiError(400, 'invalid_request', 'OIDC discovery failed: fetch failed');
  renderForm();
  fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'other' } });
  fireEvent.click(save());
  const issuer = screen.getByLabelText('Issuer URL');
  await waitFor(() => expect(issuer).toHaveAttribute('aria-invalid', 'true'));
  expect(document.getElementById(issuer.getAttribute('aria-describedby')!)).toHaveTextContent('OIDC discovery failed: fetch failed');
});

it('adds trusted proxies as tags', () => {
  renderForm();
  const input = screen.getByLabelText('Trusted proxy addresses');
  fireEvent.change(input, { target: { value: '10.0.0.0/8' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'Remove 10.0.0.0/8' })).toBeInTheDocument();
  expect(save()).toBeEnabled();
});

it('tests the connection with the issuer from the form', async () => {
  renderForm();
  fireEvent.change(screen.getByLabelText('Issuer URL'), { target: { value: 'https://idp.example.com/next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
  expect(await screen.findByText(/Couldn't reach the provider: getaddrinfo ENOTFOUND/)).toBeInTheDocument();
  expect(apiMod.api).toHaveBeenCalledWith('/admin/sso/test', { method: 'POST', json: { issuer: 'https://idp.example.com/next' } });
});

it('shows the redirect URI, the forward-auth warning, the reset command and the emergency banner', () => {
  renderForm({ ...wire, emergency: true });
  expect(screen.getByLabelText('Redirect URI')).toHaveValue('https://files.example.com/api/auth/oidc/callback');
  expect(screen.getByRole('button', { name: 'Copy redirect URI' })).toBeInTheDocument();
  expect(screen.getByText('Only behind a proxy that strips these headers')).toBeInTheDocument();
  expect(screen.getByText(/reset-admin-password\.js/)).toBeInTheDocument();
  expect(within(screen.getByRole('alert')).getByText('Emergency mode is on')).toBeInTheDocument();
});

it('warns when linking by email is turned on', () => {
  renderForm();
  expect(screen.queryByText(/takes over the Synclet account/)).toBeNull();
  fireEvent.click(screen.getByRole('switch', { name: 'Link existing accounts by email' }));
  expect(screen.getByText(/takes over the Synclet account/)).toBeInTheDocument();
});

it('warns that empty allowed groups let anyone at the IdP sign up, only while OIDC is on', () => {
  renderForm();
  expect(screen.getByText(/No allowed groups: anyone with an account/)).toBeInTheDocument();
  cleanup();
  renderForm({ ...wire, oidc: { ...wire.oidc, allowedGroups: ['staff'] } });
  expect(screen.queryByText(/No allowed groups: anyone with an account/)).toBeNull();
  cleanup();
  renderForm({ ...wire, oidc: { ...wire.oidc, enabled: false } });
  expect(screen.queryByText(/No allowed groups: anyone with an account/)).toBeNull();
});
