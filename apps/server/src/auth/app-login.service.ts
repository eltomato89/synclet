import { Injectable } from '@nestjs/common';
import type { AppTokenResponse } from '@synclet/shared';
import { createHash, randomBytes } from 'node:crypto';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { SsoSettingsService } from '../sso/sso-settings.service';
import { resolveAppClient } from './app-clients';
import { AuthService } from './auth.service';

/** Lifetime of an authorization code; the app exchanges it right after the redirect. */
export const APP_CODE_TTL_MS = 60_000;

const INVALID_GRANT = 'the sign-in expired or is invalid, please sign in again';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** PKCE S256: BASE64URL(SHA256(code_verifier)) must equal the code_challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Browser login of the native apps (OAuth 2.0 Authorization Code + PKCE). The web page `/app-login`
 * authenticates the user (password or an existing web session, so SSO works too) and redirects to the
 * app with a one-time code; the app exchanges it for tokens. Codes are stored as hashes only.
 */
@Injectable()
export class AppLoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly sso: SsoSettingsService,
  ) {}

  client(clientId: string, redirectUri: string) {
    const client = resolveAppClient(clientId, redirectUri);
    if (!client) throw new SyncError('invalid_request', 'this app is not allowed to sign in');
    return { id: client.id, name: client.name };
  }

  /** Password path: verifies credentials and applies the password-login rule, then issues a code. */
  async authorizeWithPassword(login: string, password: string, params: AuthorizeParams): Promise<{ code: string }> {
    this.client(params.clientId, params.redirectUri);
    const user = await this.auth.verifyCredentials(login, password);
    if (!(await this.sso.isPasswordLoginAllowed(user))) throw new SyncError('password_login_disabled', 'password login is disabled for users');
    return this.issueCode(user.id, params);
  }

  /** Session path: the caller is already authenticated (web token), e.g. after OIDC or forward-auth. */
  authorizeForUser(userId: string, params: AuthorizeParams): Promise<{ code: string }> {
    this.client(params.clientId, params.redirectUri);
    return this.issueCode(userId, params);
  }

  private async issueCode(userId: string, params: AuthorizeParams): Promise<{ code: string }> {
    const code = randomBytes(32).toString('base64url');
    const now = Date.now();
    await this.prisma.appAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 3_600_000) } } });
    await this.prisma.appAuthCode.create({
      data: {
        userId, codeHash: sha256(code), clientId: params.clientId, redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge, expiresAt: new Date(now + APP_CODE_TTL_MS),
      },
    });
    return { code };
  }

  async token(p: { code: string; codeVerifier: string; clientId: string; redirectUri: string }, userAgent?: string): Promise<AppTokenResponse> {
    const entry = await this.prisma.appAuthCode.findUnique({ where: { codeHash: sha256(p.code) } });
    if (
      !entry || entry.usedAt || entry.expiresAt.getTime() < Date.now() ||
      entry.clientId !== p.clientId || entry.redirectUri !== p.redirectUri ||
      pkceChallenge(p.codeVerifier) !== entry.codeChallenge
    ) {
      throw new SyncError('invalid_request', INVALID_GRANT);
    }
    // Single use: only the first caller flips usedAt.
    const claimed = await this.prisma.appAuthCode.updateMany({ where: { id: entry.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new SyncError('invalid_request', INVALID_GRANT);

    const user = await this.prisma.user.findUnique({ where: { id: entry.userId } });
    if (!user || user.disabledAt) throw new SyncError('unauthorized');
    const { access, refreshToken } = await this.auth.issueLogin(user, userAgent);
    return { ...access, refreshToken };
  }

  async refresh(refreshToken: string, userAgent?: string): Promise<AppTokenResponse> {
    const { access, refreshToken: next } = await this.auth.refresh(refreshToken, userAgent);
    return { ...access, refreshToken: next };
  }
}
