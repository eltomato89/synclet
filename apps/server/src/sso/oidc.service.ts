import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_CONFIG, AppConfig } from '../config';
import { ServerConfigService } from '../auth/server-config.service';
import { discoverOidc, oidcLib, type OidcConfiguration } from './oidc-client';
import type { SsoClaims } from './provisioning.service';
import { normalizeEmail } from './provisioning.service';
import { EffectiveOidc, errorMessage, SsoSettingsService } from './sso-settings.service';

/** Short-lived, signed, httpOnly cookie carrying the PKCE verifier, state and nonce of one login attempt. */
export const OIDC_COOKIE = 'synclet_oidc';
export const OIDC_COOKIE_PATH = '/api/auth/oidc';
export const OIDC_COOKIE_TTL_S = 600;
export const DEFAULT_RETURN = '/files';

interface FlowClaims { typ: 'oidc'; st: string; nc: string; cv: string; ret: string; iss: string }

/** Codes of `/login?sso_error=<code>` redirects. */
export type SsoErrorCode =
  | 'oidc_disabled' | 'idp_unavailable' | 'invalid_state' | 'idp_error' | 'oidc_failed'
  | 'sso_not_allowed' | 'unauthorized' | 'rate_limited' | 'server_error';

export class OidcFlowError extends Error {
  constructor(readonly code: SsoErrorCode, message?: string) { super(message ?? code); }
}

/**
 * Only same-origin relative paths are accepted as post-login targets (`/x`, not `//host`, `/\host`
 * or anything with control characters); everything else becomes `/files`.
 */
export function safeReturnPath(ret: unknown): string {
  if (typeof ret !== 'string' || ret.length === 0 || ret.length > 2000) return DEFAULT_RETURN;
  if (!ret.startsWith('/') || ret.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(ret)) return DEFAULT_RETURN;
  try {
    const base = new URL('http://synclet.invalid');
    const u = new URL(ret, base);
    if (u.origin !== base.origin) return DEFAULT_RETURN;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return DEFAULT_RETURN;
  }
}

/** Value of a claim by name, or by dotted path for nested claims (e.g. `realm_access.roles`). */
function claimValue(claims: Record<string, unknown>, name: string): unknown {
  if (name in claims) return claims[name];
  return name.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), claims);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

@Injectable()
export class OidcService {
  private readonly log = new Logger('Oidc');
  private client?: { key: string; config: Promise<OidcConfiguration> };

  constructor(
    private readonly settings: SsoSettingsService,
    private readonly serverConfig: ServerConfigService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async secret() { return (await this.serverConfig.get()).jwtSecret; }

  private async effective(): Promise<EffectiveOidc> {
    const oidc = (await this.settings.effective()).oidc;
    if (!oidc) throw new OidcFlowError('oidc_disabled');
    return oidc;
  }

  /** Discovered client for the current settings (cached until the settings change; failures are not cached). */
  private async configuration(oidc: EffectiveOidc): Promise<OidcConfiguration> {
    const key = `${oidc.version}|${oidc.issuer}|${oidc.clientId}`;
    if (this.client?.key !== key) {
      const config = (async () => discoverOidc(
        { issuer: oidc.issuer, clientId: oidc.clientId, clientSecret: await this.settings.openClientSecret(oidc.clientSecretEnc) },
        this.config.ssoAllowHttpIssuer,
      ))();
      const entry = { key, config };
      config.catch(() => { if (this.client === entry) this.client = undefined; });
      this.client = entry;
    }
    try {
      return await this.client.config;
    } catch (e) {
      this.log.warn(`OIDC discovery failed: ${errorMessage(e)}`);
      throw new OidcFlowError('idp_unavailable');
    }
  }

  /** Authorization URL (code flow, PKCE S256, state, nonce) and the flow cookie value. */
  async start(returnTo: unknown): Promise<{ url: string; cookie: string }> {
    const oidc = await this.effective();
    const config = await this.configuration(oidc);
    const client = await oidcLib();
    const cv = client.randomPKCECodeVerifier();
    const st = client.randomState();
    const nc = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: oidc.redirectUri, response_type: 'code', scope: oidc.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(cv), code_challenge_method: 'S256', state: st, nonce: nc,
    });
    const claims: FlowClaims = { typ: 'oidc', st, nc, cv, ret: safeReturnPath(returnTo), iss: oidc.issuer };
    const cookie = await this.jwt.signAsync(claims, { secret: await this.secret(), expiresIn: OIDC_COOKIE_TTL_S });
    return { url: url.href, cookie };
  }

  /**
   * Validates the authorization response (state, then code exchange with PKCE, id_token signature,
   * issuer, audience, nonce) and returns the normalized identity plus the post-login path.
   */
  async callback(rawQuery: string, cookie: string | undefined): Promise<{ claims: SsoClaims; returnTo: string }> {
    const oidc = await this.effective();
    let flow: FlowClaims | null = null;
    if (cookie) {
      try {
        flow = await this.jwt.verifyAsync<FlowClaims>(cookie, { secret: await this.secret() });
      } catch {
        flow = null;
      }
    }
    if (!flow || flow.typ !== 'oidc' || flow.iss !== oidc.issuer) throw new OidcFlowError('invalid_state', 'missing or expired login attempt');
    const params = new URLSearchParams(rawQuery);
    if (params.get('state') !== flow.st) throw new OidcFlowError('invalid_state', 'state mismatch');
    if (params.has('error')) {
      throw new OidcFlowError('idp_error', `${params.get('error')}: ${params.get('error_description') ?? ''}`.slice(0, 300));
    }
    const config = await this.configuration(oidc);
    const client = await oidcLib();
    const currentUrl = new URL(oidc.redirectUri);
    currentUrl.search = params.toString();
    let claims: Record<string, unknown>;
    try {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: flow.cv, expectedState: flow.st, expectedNonce: flow.nc, idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims) throw new Error('no id_token');
      claims = { ...idClaims };
      if (tokens.access_token && config.serverMetadata().userinfo_endpoint) {
        try {
          const info = await client.fetchUserInfo(config, tokens.access_token, idClaims.sub);
          claims = { ...info, ...idClaims }; // id_token claims win; userinfo fills the rest (e.g. groups, email)
        } catch (e) {
          this.log.warn(`OIDC userinfo failed, using id_token claims only: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      if (e instanceof OidcFlowError) throw e;
      this.log.warn(`OIDC code exchange/validation failed: ${errorMessage(e)}`);
      throw new OidcFlowError('oidc_failed', errorMessage(e));
    }

    const groupsRaw = claimValue(claims, oidc.groupsClaim);
    const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : str(groupsRaw) ? [str(groupsRaw)!] : [];
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    return {
      claims: {
        provider: `oidc:${oidc.issuer}`,
        subject: String(claims.sub),
        email: normalizeEmail(str(claims.email)),
        emailVerified: verified,
        preferredUsername: str(claimValue(claims, oidc.usernameClaim)) ?? str(claims.preferred_username),
        name: str(claims.name),
        groups,
      },
      returnTo: flow.ret,
    };
  }
}
